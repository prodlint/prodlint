import type { Rule, Finding, FileContext, ProjectContext } from '../types.js'
import { isCommentLine } from '../utils/patterns.js'
import { walkAST, isTaggedTemplateSql, unwrapExpression } from '../utils/ast.js'
import { bindNames } from '../utils/scopes.js'
import type { Binding } from '../utils/scopes.js'
import { SQL_SAFE_ORMS } from '../utils/frameworks.js'
import type { Node } from '@babel/types'

// Patterns for unsafe SQL construction
const SQL_INJECTION_PATTERNS = [
  // Template literals with SQL keywords and interpolation
  { pattern: /`\s*(?:SELECT|INSERT|UPDATE|DELETE|DROP|ALTER|CREATE)\b[^`]*\$\{/, message: 'SQL query built with template literal interpolation — use parameterized queries' },
  // String concatenation with SQL
  { pattern: /(?:SELECT|INSERT|UPDATE|DELETE|DROP)\b.*['"]?\s*\+\s*\w/, message: 'SQL query built with string concatenation — use parameterized queries' },
  // .query() or .execute() with template literal
  { pattern: /\.(?:query|execute|raw)\s*\(\s*`[^`]*\$\{/, message: 'Database query with template literal interpolation — use parameterized queries' },
]

// Regex-based tagged template detection (fallback when no AST)
const TAGGED_TEMPLATE_PREFIX = /\b(?:sql|Prisma\.sql|db\.sql|db\.query)\s*`/

// Regex for parameterized query patterns: .query(sql, [params])
const PARAMETERIZED_QUERY = /\.(?:query|execute)\s*\([^,]+,\s*\[/

// Prisma's raw queries, on any receiver (prisma, tx, db, ctx.prisma). As a tag, $queryRaw`...` and
// $executeRaw`...` send what the template interpolates as parameters. Called with a string, the
// Unsafe pair runs it as written
const PRISMA_RAW_CALL = /^\$(?:queryRaw|executeRaw)(?:Unsafe)?$/
// The tags called with a string: Prisma 3 and later throw ("is a tag function"), Prisma 2 ran it
// as written. Wrong either way, and not an injection on a current Prisma, so never critical
const TAG_CALLED = /^\$(?:queryRaw|executeRaw)$/

// The statements values go into, where a parameter can carry them. What goes into a TRUNCATE, a
// SET or a SAVEPOINT is a table, a setting or a name
const TAKES_VALUES = new Set(['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'WITH', 'MERGE', 'REPLACE', 'CALL', 'EXEC', 'EXECUTE'])

/**
 * Whether a query starts with a statement that takes values, past spaces, parentheses and
 * comments. A loop, not a regex: a regex that skips comments can match a run of them, or a line
 * of dashes, in so many ways that it backtracks for minutes. Where the query takes something
 * in (TAKEN_IN) before its first word, there's no statement to read
 */
function takesValues(sql: string): boolean {
  let i = 0
  for (;;) {
    while (/[\s(]/.test(sql[i] ?? '')) i++
    const close = sql.startsWith('--', i) ? '\n' : sql.startsWith('/*', i) ? '*/' : null
    if (!close) break
    const end = sql.indexOf(close, i + 2)
    if (end === -1) return false
    i = end + close.length
  }
  const word = /^\w+/.exec(sql.slice(i))?.[0]
  return word !== undefined && TAKES_VALUES.has(word.toUpperCase())
}

type How = 'interpolation' | 'concatenation'

/** A string built from values and handed to one of Prisma's raw calls */
interface BuiltQuery {
  /** $queryRawUnsafe, $executeRawUnsafe, $queryRaw, $executeRaw or Prisma.raw */
  method: string
  how: How
  /**
   * A statement that takes values, with none passed after it: they can only be in its text.
   * One that passes them interpolates a name or a piece of SQL, and stays a warning, as do a
   * tag called with a string and a query that takes in nothing but quoted names
   */
  critical: boolean
}

/** What a file shows of Prisma's raw queries: read from the syntax tree or, without one, from the text */
interface Queries {
  /**
   * Lines of the queries nothing is built into: a tagged template, which sends what it
   * interpolates as parameters, and a constant handed to a raw call
   */
  safe: Set<number>
  /** The line a built query starts on → the call it's handed to */
  built: Map<number, BuiltQuery>
  /** Every line of those built queries */
  builtLines: Set<number>
}

function addLines(lines: Set<number>, from: number, to: number): void {
  for (let line = from; line <= to; line++) lines.add(line)
}

function addBuilt(queries: Queries, from: number, to: number, query: BuiltQuery): void {
  // One finding a line: of two queries that start on it, the first, or the critical one
  const first = queries.built.get(from)
  if (!first || (query.critical && !first.critical)) queries.built.set(from, query)
  addLines(queries.builtLines, from, to)
}

// What a query takes in, in the texts textsOf() gives of it
const TAKEN_IN = '\0'
// How many texts a name is read as, when a list or a `?:` makes it one of several
const MAX_TEXTS = 8

/** What a file's names hold, read once a query takes one in */
interface Names {
  /** The declaration a name refers to where it stands, if the file has it */
  bindingOf(name: Node): Binding | undefined
  /** Every text the constant a name holds can be, or null for a name that doesn't hold one */
  constantOf(name: Node): string[] | null
  /** What the names read as constants so far are declared with */
  constants: Node[]
}

/** Whether a string takes in nothing, in any text it can be: a literal, or constants all through */
const isConstant = (texts: string[]): boolean => !texts.some(text => text.includes(TAKEN_IN))

/**
 * The texts two halves make. A half that can be several, a `?:` or a list's name, goes through
 * them in step with the other: the first of each, then the second of each. So a `?:` written
 * twice, or a name used twice, reads the same way both times
 */
function joined(left: string[], right: string[]): string[] {
  const count = Math.max(left.length, right.length)
  return Array.from({ length: count }, (_, i) => left[i % left.length] + right[i % right.length])
}

/**
 * Every text a string can be, with a NUL for each thing it takes in. A constant takes in
 * nothing and is read as its text: a literal, a name that holds one (Names.constantOf), a `+`
 * or a template of constants, and a `?:` between two, which can be either. Anything else in a
 * `${}` or a `+` is taken in, whatever it holds: a parameter, an import, a property, what a
 * call returns
 */
function textsOf(node: Node, names: Names): string[] {
  node = unwrapExpression(node)
  if (node.type === 'StringLiteral' || node.type === 'NumericLiteral') return [String(node.value)]
  if (node.type === 'Identifier') return names.constantOf(node) ?? [TAKEN_IN]
  if (node.type === 'BinaryExpression' && node.operator === '+') return joined(textsOf(node.left, names), textsOf(node.right, names))
  if (node.type === 'ConditionalExpression') {
    const either = [...textsOf(node.consequent, names), ...textsOf(node.alternate, names)]
    return isConstant(either) ? either : [TAKEN_IN]
  }
  if (node.type === 'TemplateLiteral') {
    const written = node.quasis.map(quasi => quasi.value.cooked ?? quasi.value.raw)
    // What a `${}` holds is one thing taken in, unless all of it is a constant
    const held = node.expressions.map((expression) => {
      const texts = textsOf(expression, names)
      return isConstant(texts) ? texts : [TAKEN_IN]
    })
    // In step, as joined() has them. Each text is put together once, however many `${}` it has
    const count = held.reduce((most, texts) => Math.max(most, texts.length), 1)
    return Array.from({ length: count }, (_, i) =>
      written.map((text, at) => at < held.length ? text + held[at][i % held[at].length] : text).join(''))
  }
  return [TAKEN_IN]
}

/** Every string an argument can be: either branch of a `?:`, and of the `?:`s in those */
function branches(node: Node): Node[] {
  node = unwrapExpression(node)
  return node.type === 'ConditionalExpression' ? [...branches(node.consequent), ...branches(node.alternate)] : [node]
}

/**
 * How a string that takes something in is built: a template that interpolates, or a `+`. Null
 * for what isn't a string the file shows there: a name, what a call returns
 */
function howBuilt(node: Node): How | null {
  if (node.type === 'TemplateLiteral') return 'interpolation'
  return node.type === 'BinaryExpression' && node.operator === '+' ? 'concatenation' : null
}

const QUOTED_NAME = /^[\w$\0]+$/
// Where a table's name goes
const TABLE_KEYWORD = /\b(?:FROM|JOIN|INTO|UPDATE)\s*$/i
// A FROM that a value follows: EXTRACT(YEAR FROM x), TRIM(BOTH y FROM x), a IS DISTINCT FROM x
const VALUE_FROM = /\b(?:EXTRACT|TRIM)\s*\([^)]*\bFROM\s*$|\bDISTINCT\s+FROM\s*$/i

/**
 * Whether a double-quoted name is where only a name can be: after a keyword that takes a table,
 * or in a dotted name ("public"."users", u."email"). Anywhere else MySQL and SQLite can read
 * double quotes as a string, and what's between them is then a value: VALUES ("${name}")
 */
function isTableName(sql: string, open: number, close: number): boolean {
  // The keyword is right before the quote, so a short look back does, however long the query
  const before = sql.slice(Math.max(0, open - 100), open)
  return /\.\s*$/.test(before) || /^\s*\./.test(sql.slice(close + 1, close + 20)) ||
    (TABLE_KEYWORD.test(before) && !VALUE_FROM.test(before))
}

/**
 * Whether all a built query takes in is quoted names, which no parameter can carry: between
 * backticks, MySQL's quote for a name, or between double quotes where a table's name goes. A
 * value between single quotes, a bare one, and a name the query doesn't quote all say no
 */
function takesNamesOnly(sql: string): boolean {
  for (let i = 0; i < sql.length; i++) {
    const quote = sql[i]
    if (quote === TAKEN_IN) return false
    if (quote !== "'" && quote !== '"' && quote !== '`') continue
    // To the next quote like it. A doubled one inside ('it''s') reads as two strings side by
    // side, which leaves what follows as much outside a string as it was
    const close = sql.indexOf(quote, i + 1)
    // One that never closes holds the rest
    if (close === -1) return !sql.includes(TAKEN_IN, i)
    const inside = sql.slice(i + 1, close)
    if (inside.includes(TAKEN_IN)) {
      if (quote === "'" || !QUOTED_NAME.test(inside)) return false
      if (quote === '"' && !isTableName(sql, i, close)) return false
    }
    i = close
  }
  return true
}

/** Which of Prisma's raw calls a callee is: one of the four methods, by its name, or Prisma.raw */
function rawCall(callee: Node): string | null {
  if (callee.type === 'Identifier') return PRISMA_RAW_CALL.test(callee.name) ? callee.name : null
  if (callee.type !== 'MemberExpression' && callee.type !== 'OptionalMemberExpression') return null
  if (callee.computed || callee.property.type !== 'Identifier') return null
  const name = callee.property.name
  if (PRISMA_RAW_CALL.test(name)) return name
  return name === 'raw' && callee.object.type === 'Identifier' && callee.object.name === 'Prisma' ? 'Prisma.raw' : null
}

/** A raw call: which one, and whether the query is all it's handed, with no values after it */
interface RawCall {
  method: string
  alone: boolean
}

/** A string a raw call is handed: how it's built, and every text it can be (textsOf) */
interface Built {
  node: Node
  how: How
  texts: string[]
}

/**
 * A string built for a raw call, reported where it starts. `pieces` are the texts of what a
 * name appends to it with `+=`: SQL of the same query, read after the string's own. A query
 * that can be several texts is critical if one of them is
 */
function addQuery(queries: Queries, call: RawCall, built: Built, pieces: string[][] = []): void {
  if (!built.node.loc) return
  const whole = pieces.reduce(joined, built.texts)
  // The statement is the string's own: which piece comes first isn't read
  const critical = !TAG_CALLED.test(call.method) && call.alone && built.texts.some(takesValues) && !whole.every(takesNamesOnly)
  addBuilt(queries, built.node.loc.start.line, built.node.loc.end.line, { method: call.method, how: built.how, critical })
}

/**
 * What a name carries into a raw call: every string the file sets it to, in whatever order,
 * since the order statements run in isn't read. Each is a query of its own, judged as if it
 * were written in the call. Appended to with `+=`, a query is built by concatenation unless
 * every piece is a constant, and it's still one query: reported where it starts, not piece by piece
 */
function readName(queries: Queries, call: RawCall, binding: Binding, names: Names): void {
  const pieces = binding.values.filter(value => value.append).map(value => value.node)
  const appended = pieces.map(piece => textsOf(piece, names))
  const grown = !appended.every(isConstant)
  // Whether the file shows a string the name starts as: a parameter or a call's result isn't one
  let shown = false
  for (const { node, append } of binding.values) {
    if (append) continue
    for (const string of branches(node)) {
      const texts = textsOf(string, names)
      const constant = isConstant(texts)
      const how = constant ? (grown ? 'concatenation' : null) : howBuilt(string)
      if (how) addQuery(queries, call, { node: string, how, texts }, appended)
      // A constant has nothing built into it, in the call or by its name
      else if (constant && string.loc) addLines(queries.safe, string.loc.start.line, string.loc.end.line)
      shown ||= constant || how !== null
    }
  }
  // The pieces are lines of that query, which is reported where it starts or has nothing built
  // into it. One that starts out of sight is left to the patterns, pieces and all
  if (!shown) return
  for (const piece of pieces) {
    if (piece.loc) addLines(queries.builtLines, piece.loc.start.line, piece.loc.end.line)
  }
}

// What reads a list and leaves it as it is
const LIST_READ = /^(?:length|includes|indexOf|join|map|forEach|filter|some|every|find|slice)$/

/**
 * Whether nothing in the file can add to an array a `const` holds: the file names it only to
 * declare it, to loop over it or to read it, and doesn't export it. By the name alone, whichever
 * declaration each mention is of, so a push() to anything called that says no. A property or a
 * key of that name (`out.tables`, `{ tables: [] }`) isn't a mention of it
 */
function onlyRead(program: Node, name: string): boolean {
  let read = true
  walkAST(program, (node, parent) => {
    if (node.type === 'ExportNamedDeclaration') {
      const declares = node.declaration?.type === 'VariableDeclaration' ? node.declaration.declarations : []
      if (declares.some(({ id }) => id.type === 'Identifier' && id.name === name)) read = false
    }
    if (node.type !== 'Identifier' || node.name !== name || !parent) return
    if (parent.type === 'VariableDeclarator' && parent.id === node) return
    // A loop over it, and a type made of it: (typeof tables)[number]
    if (parent.type === 'ForOfStatement' || parent.type === 'TSTypeQuery') return
    if ((parent.type === 'MemberExpression' || parent.type === 'OptionalMemberExpression') && !parent.computed) {
      // The property itself, or the list something reads
      if (parent.property === node || (parent.property.type === 'Identifier' && LIST_READ.test(parent.property.name))) return
    }
    // A key, which `{ tables }` has too, next to the value: that one is a mention
    if (parent.type === 'ObjectProperty' && parent.key === node && !parent.computed) return
    read = false
  })
  return read
}

/**
 * What the names of a file hold. A constant is a name declared with `const` whose value is one
 * (textsOf), and the `const` of a `for…of` loop over a list of them: an array written in the
 * loop, or held by a `const` that nothing can add to. Scopes are read at the first name asked
 * for, so not for a file whose queries take in none, and the file's loops at the first `const`
 * that has no value of its own
 */
function readNames(program: Node): Names {
  let bound: Map<Node, Binding> | undefined
  let loops: Map<Binding | undefined, Node> | undefined
  const memo = new Map<Binding, string[] | null>()
  const read = new Map<string, boolean>()

  /** What the `for…of` loop that declares a variable goes over, if a loop does */
  const listOf = (variable: Binding): Node | undefined => {
    if (!loops) {
      const found = loops = new Map()
      walkAST(program, (node) => {
        if (node.type === 'ForOfStatement' && node.left.type === 'VariableDeclaration') found.set(names.bindingOf(node.left.declarations[0].id), node.right)
      })
    }
    return loops.get(variable)
  }

  /** Every text a loop's variable can be: the elements of the list it goes over */
  const elementsOf = (list: Node | undefined): string[] | null => {
    if (!list) return null
    list = unwrapExpression(list)
    if (list.type === 'Identifier') {
      const array = names.bindingOf(list)
      const held = array?.constant ? array.values[0] : undefined
      if (!read.has(list.name)) read.set(list.name, onlyRead(program, list.name))
      if (!held || !read.get(list.name)) return null
      list = unwrapExpression(held.node)
    }
    // A list with nothing in it has no text to read
    if (list.type !== 'ArrayExpression' || list.elements.length === 0) return null
    // A hole, like a spread or a name that holds no constant, is something taken in: the list
    // isn't one the file shows whole
    return list.elements.flatMap(element => element ? textsOf(element, names) : [TAKEN_IN])
  }

  const names: Names = {
    constants: [],
    bindingOf(name) {
      bound ??= bindNames(program)
      return bound.get(name)
    },
    constantOf(name) {
      const binding = names.bindingOf(name)
      if (!binding?.constant) return null
      const known = memo.get(binding)
      if (known !== undefined) return known
      // Until it's read: a name whose value leads back to it holds no constant
      memo.set(binding, null)
      // A `const` with no value of its own is a loop's, or taken out of something
      const value = binding.values[0]
      let texts = value ? textsOf(value.node, names) : elementsOf(listOf(binding))
      // A long list, or a `?:` between names that are each a `?:`, is read in its first few texts
      texts = texts && isConstant(texts) ? texts.slice(0, MAX_TEXTS) : null
      if (texts && value) names.constants.push(value.node)
      memo.set(binding, texts)
      return texts
    },
  }
  return names
}

function readTree(ast: NonNullable<FileContext['ast']>): Queries {
  const queries: Queries = { safe: new Set(), built: new Map(), builtLines: new Set() }
  // The raw calls, read once the tree is walked, with what each is handed
  const calls: { call: RawCall; query: Node }[] = []
  walkAST(ast.program, (node) => {
    if (node.type === 'TaggedTemplateExpression') {
      if (isTaggedTemplateSql(node) && node.loc) {
        addLines(queries.safe, node.loc.start.line, node.loc.end.line)
      }
    } else if (node.type === 'CallExpression' || node.type === 'OptionalCallExpression') {
      const method = rawCall(node.callee)
      if (method && node.arguments.length > 0) calls.push({ call: { method, alone: node.arguments.length === 1 }, query: node.arguments[0] })
    }
  })

  const names = readNames(ast.program)
  for (const { call, query } of calls) {
    for (const string of branches(query)) {
      const texts = textsOf(string, names)
      if (isConstant(texts)) {
        // A constant has nothing built into it, whatever a `+` or a `${}` in its SQL looks
        // like to the patterns. One handed over by name is read below, where it's set
        if (string.type !== 'Identifier' && string.loc) addLines(queries.safe, string.loc.start.line, string.loc.end.line)
        continue
      }
      const how = howBuilt(string)
      if (how) addQuery(queries, call, { node: string, how, texts })
    }
  }
  // A query built into a variable and handed over by name: followed to what the file sets the
  // name to
  const named = new Map<Binding, RawCall[]>()
  for (const { call, query } of calls) {
    const name = unwrapExpression(query)
    const binding = name.type === 'Identifier' ? names.bindingOf(name) : undefined
    if (binding) named.set(binding, [...(named.get(binding) ?? []), call])
  }
  for (const [binding, handedTo] of named) {
    // One call that passes values says the query has places for them, as in
    // params.length ? run(sql, ...params) : run(sql)
    const alone = handedTo.every(call => call.alone)
    for (const { method } of handedTo) readName(queries, { method, alone }, binding, names)
  }
  // A constant that a query takes in has nothing built into it either, where it's declared
  for (const value of names.constants) {
    if (value.loc) addLines(queries.safe, value.loc.start.line, value.loc.end.line)
  }
  return queries
}

// Without a syntax tree, Prisma's raw queries as the text has them: the method, a type argument
// if it has one, then a template or a call. A regex literal with a quote in it, as in
// .replace(/'/g, "''"), isn't understood, and a query with one is left to the patterns above, as
// is an argument that's a `?:` or a constant. So is a query handed over by name: there are no
// scopes to say which declaration a name is, nor what it holds, so a constant in a `${}` is
// something taken in here. A quoted name isn't told from a value either. The other tags stay
// with TAGGED_TEMPLATE_PREFIX, a line at a time
const TEXT_RAW = /(\$(?:queryRaw|executeRaw)(?:Unsafe)?|\bPrisma\.(?:raw|sql))\b/g
const TEXT_TAG = /^(?:\$(?:queryRaw|executeRaw)|Prisma\.sql)$/
const TEXT_NAME = /[\w$.]+/y
const TEXT_PLUS = /\s*\+\s*/y

function pastSpace(text: string, i: number): number {
  while (/\s/.test(text[i] ?? '')) i++
  return i
}

/** Index of the `>` that closes the type argument opened at `open`, on its line or lines below, or -1 */
function typeArgumentEnd(text: string, open: number): number {
  let depth = 0
  // A type argument is short: without a limit, a `<` that compares would be read to the end of the file
  const limit = Math.min(text.length, open + 2000)
  for (let i = open; i < limit; i++) {
    if (text[i] === '<') depth++
    else if (text[i] === '>' && text[i - 1] !== '=' && --depth === 0) return i
  }
  return -1
}

/** Index of the quote that closes the string opened at `open`, or -1 if its line ends first */
function stringEnd(text: string, open: number): number {
  for (let i = open + 1; i < text.length; i++) {
    if (text[i] === '\\') i++
    else if (text[i] === text[open]) return i
    else if (text[i] === '\n' || text[i] === '\r') return -1
  }
  return -1
}

/** Index of the backtick that closes the template opened at `open`, past each `${}` and what it nests, or -1 */
function templateEnd(text: string, open: number): number {
  for (let i = open + 1; i < text.length; i++) {
    if (text[i] === '\\') i++
    else if (text[i] === '`') return i
    else if (text[i] === '$' && text[i + 1] === '{') {
      let depth = 0
      for (i++; i < text.length; i++) {
        const ch = text[i]
        if (ch === '`' || ch === '"' || ch === "'") {
          i = ch === '`' ? templateEnd(text, i) : stringEnd(text, i)
          if (i === -1) return -1
        } else if (ch === '{') depth++
        else if (ch === '}' && --depth === 0) break
      }
    }
  }
  return -1
}

/** The string the text builds from values at `at`, where a call's first argument starts: its end, or null */
function builtText(text: string, at: number): { end: number; how: How } | null {
  let end = -1
  let operands = 0
  let constant = true
  for (let i = at; ; i = TEXT_PLUS.lastIndex) {
    const ch = text[i]
    if (ch === '`' || ch === '"' || ch === "'") {
      end = ch === '`' ? templateEnd(text, i) : stringEnd(text, i)
      if (end === -1) return null
      if (ch === '`' && text.slice(i, end).includes('${')) constant = false
    } else {
      // A name: whatever it holds, it isn't a literal. Nor is what this can't read after a `+`,
      // a parenthesis say, and the string ends there as far as the text goes
      TEXT_NAME.lastIndex = i
      const name = TEXT_NAME.exec(text)
      if (!name && operands === 0) return null
      constant = false
      if (!name) {
        operands++
        break
      }
      end = i + name[0].length - 1
    }
    operands++
    TEXT_PLUS.lastIndex = end + 1
    if (!TEXT_PLUS.test(text)) break
  }
  if (constant) return null
  if (operands === 1) return text[at] === '`' ? { end, how: 'interpolation' } : null
  return { end, how: 'concatenation' }
}

/**
 * Whether a call passes more than the argument that starts at `at`: a comma at the call's own
 * depth before the `)` that closes it. In doubt, no
 */
function passesMore(text: string, at: number): boolean {
  let depth = 0
  const limit = Math.min(text.length, at + 20000)
  for (let i = at; i < limit; i++) {
    const ch = text[i]
    if (ch === '`' || ch === '"' || ch === "'") {
      i = ch === '`' ? templateEnd(text, i) : stringEnd(text, i)
      if (i === -1) return false
    } else if (ch === '(' || ch === '[' || ch === '{') depth++
    else if (ch === ')' || ch === ']' || ch === '}') {
      if (depth-- === 0) return false
    } else if (ch === ',' && depth === 0) {
      // Not the comma a formatter leaves before the `)`
      return text[pastSpace(text, i + 1)] !== ')'
    }
  }
  return false
}

function readText(file: FileContext): Queries {
  const queries: Queries = { safe: new Set(), built: new Map(), builtLines: new Set() }
  const text = file.content
  // Where each line starts, split as file.lines is
  const starts = [0]
  for (const lineBreak of text.matchAll(/\r?\n|\r/g)) starts.push(lineBreak.index + lineBreak[0].length)
  // The 1-indexed line of a character: the last line that starts at or before it
  const lineOf = (index: number): number => {
    let low = 0
    let high = starts.length - 1
    while (low < high) {
      const mid = (low + high + 1) >> 1
      if (starts[mid] <= index) low = mid
      else high = mid - 1
    }
    return low + 1
  }

  // What a line says before each match, read once however many matches it has: whether it's a
  // comment, and how many backticks come before the match
  let line = 0
  let comment = false
  let counted = 0
  let backticks = 0
  for (const raw of text.matchAll(TEXT_RAW)) {
    const method = raw[1]
    const from = lineOf(raw.index)
    if (from !== line) {
      line = from
      comment = isCommentLine(file.lines, from - 1, file.commentMap)
      counted = starts[from - 1]
      backticks = 0
    }
    if (comment) continue
    for (; counted < raw.index; counted++) if (text[counted] === '`') backticks++
    let i = pastSpace(text, raw.index + raw[0].length)
    if (text[i] === '<') {
      const close = typeArgumentEnd(text, i)
      if (close === -1) continue
      i = pastSpace(text, close + 1)
    }
    if (text[i] === '`') {
      // Between backticks already, the name is a mention in a string ("use `prisma.$queryRaw`"),
      // and what follows it closes that, it doesn't open a template
      if (!TEXT_TAG.test(method) || backticks % 2 === 1) continue
      const close = templateEnd(text, i)
      // A template that never closes: the line it opens on is all there is to go by
      addLines(queries.safe, from, lineOf(close === -1 ? i : close))
    } else if (method !== 'Prisma.sql' && (text[i] === '(' || text.startsWith('?.(', i))) {
      const at = pastSpace(text, text.indexOf('(', i) + 1)
      const built = builtText(text, at)
      if (!built) continue
      const start = /['"`]/.test(text[at]) ? text.slice(at + 1, built.end) : ''
      const critical = !TAG_CALLED.test(method) && takesValues(start) && !passesMore(text, at)
      addBuilt(queries, lineOf(at), lineOf(built.end), { method, how: built.how, critical })
    }
  }
  return queries
}

/** What to say about a built query, and what to do instead */
function report(query: BuiltQuery): { message: string; fix: string } {
  const how = query.how === 'interpolation' ? 'template literal interpolation' : 'string concatenation'
  if (query.method === 'Prisma.raw') {
    return {
      message: `Prisma.raw() string built with ${how} — it goes into the query as written, keep values out of it`,
      fix: "Interpolate values in the tagged template itself, or build the piece with Prisma.sql`...`. A table or column name can't be a parameter: check it against a fixed list",
    }
  }
  const tag = query.method.replace('Unsafe', '')
  if (query.method === tag) {
    return {
      message: `${tag}() called with a string built with ${how} — it takes a tagged template: Prisma 3 and later throw on a string, Prisma 2 runs it as written`,
      fix: `Call it as a tagged template, without the parentheses: prisma.${tag}\`... WHERE id = \${id}\``,
    }
  }
  return {
    message: `${query.method}() query built with ${how} — use the ${tag} tagged template or pass values as parameters`,
    fix: `Use prisma.${tag}\`... WHERE id = \${id}\`, or pass the values after the query: prisma.${query.method}('... WHERE id = $1', id). A table or column name can't be a parameter: check it against a fixed list`,
  }
}

export const sqlInjectionRule: Rule = {
  id: 'sql-injection',
  name: 'SQL Injection Risk',
  description: 'Detects SQL queries built with string interpolation or concatenation',
  category: 'security',
  severity: 'critical',
  fileExtensions: ['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs'],

  check(file: FileContext, project: ProjectContext): Finding[] {
    const findings: Finding[] = []

    // Tagged templates that parameterize and the strings built for Prisma's raw calls, from the
    // syntax tree if the file has one
    let tree: Queries | null = null
    if (file.ast) {
      try {
        tree = readTree(file.ast)
      } catch {
        // AST walk failed, fall back to regex
      }
    }
    const queries = tree ?? readText(file)

    // Determine if project uses a safe ORM
    const usesORM = [...project.detectedFrameworks].some(f => SQL_SAFE_ORMS.has(f))

    for (let i = 0; i < file.lines.length; i++) {
      if (isCommentLine(file.lines, i, file.commentMap)) continue

      const line = file.lines[i]
      const lineNum = i + 1 // 1-indexed

      // A string built for one of Prisma's raw calls is reported where it starts, whatever its
      // SQL says. The call is Prisma's whether or not a package.json lists it, and it's the one
      // that doesn't parameterize, so what it's given decides the severity, not the ORM
      const built = queries.built.get(lineNum)
      if (built) {
        findings.push({
          ruleId: 'sql-injection',
          file: file.relativePath,
          line: lineNum,
          column: 1,
          severity: built.critical ? 'critical' : 'warning',
          category: 'security',
          ...report(built),
        })
        continue
      }

      // Skip the rest of that string, and the tagged templates that parameterize
      if (queries.builtLines.has(lineNum) || queries.safe.has(lineNum)) continue

      // Regex fallback: skip lines that are tagged template literals
      if (!tree && TAGGED_TEMPLATE_PREFIX.test(line)) continue

      // Skip parameterized queries (.query(sql, [params]))
      if (PARAMETERIZED_QUERY.test(line)) continue

      for (const { pattern, message } of SQL_INJECTION_PATTERNS) {
        if (pattern.test(line)) {
          // If project uses an ORM that parameterizes by default, downgrade to warning
          const severity = usesORM ? 'warning' as const : 'critical' as const

          findings.push({
            ruleId: 'sql-injection',
            file: file.relativePath,
            line: lineNum,
            column: 1,
            message,
            severity,
            category: 'security',
            fix: "Use parameterized queries: db.query('SELECT * FROM users WHERE id = $1', [id])",
          })
          break // One finding per line is enough
        }
      }
    }

    return findings
  },
}
