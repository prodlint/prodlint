import type { Rule, Finding, FileContext, ProjectContext } from '../types.js'
import { isCommentLine } from '../utils/patterns.js'
import { walkAST, isTaggedTemplateSql, unwrapExpression } from '../utils/ast.js'
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
 * of dashes, in so many ways that it backtracks for minutes
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
   * One that passes them interpolates a name or a piece of SQL, and stays a warning, as does a
   * tag called with a string
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

/** Whether no value goes into a string: a literal, or a `+` of literals */
function isConstantString(node: Node): boolean {
  node = unwrapExpression(node)
  if (node.type === 'BinaryExpression') {
    return node.operator === '+' && isConstantString(node.left) && isConstantString(node.right)
  }
  return node.type === 'StringLiteral' || node.type === 'NumericLiteral' ||
    (node.type === 'TemplateLiteral' && node.expressions.length === 0)
}

/**
 * The strings an argument builds from values: a template that interpolates or a `+` that isn't
 * all literals, in either branch if the argument is a `?:`
 */
function builtStrings(node: Node): { node: Node; how: How }[] {
  node = unwrapExpression(node)
  if (node.type === 'ConditionalExpression') return [...builtStrings(node.consequent), ...builtStrings(node.alternate)]
  if (node.type === 'TemplateLiteral' && node.expressions.length > 0) return [{ node, how: 'interpolation' }]
  if (node.type === 'BinaryExpression' && node.operator === '+' && !isConstantString(node)) return [{ node, how: 'concatenation' }]
  return []
}

/** The text a built string starts with, or '' if it starts with a value */
function startOf(node: Node): string {
  node = unwrapExpression(node)
  if (node.type === 'BinaryExpression') return startOf(node.left)
  if (node.type === 'StringLiteral') return node.value
  if (node.type === 'TemplateLiteral') return node.quasis[0].value.cooked ?? node.quasis[0].value.raw
  return ''
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

function readTree(ast: NonNullable<FileContext['ast']>): Queries {
  const queries: Queries = { safe: new Set(), built: new Map(), builtLines: new Set() }
  walkAST(ast.program, (node) => {
    if (node.type === 'TaggedTemplateExpression') {
      if (isTaggedTemplateSql(node) && node.loc) {
        addLines(queries.safe, node.loc.start.line, node.loc.end.line)
      }
    } else if (node.type === 'CallExpression' || node.type === 'OptionalCallExpression') {
      const method = rawCall(node.callee)
      if (!method || node.arguments.length === 0) return
      const query = node.arguments[0]
      // A constant has nothing built into it, whatever a `+` in its SQL looks like to the patterns
      if (isConstantString(query) && query.loc) addLines(queries.safe, query.loc.start.line, query.loc.end.line)
      for (const built of builtStrings(query)) {
        if (!built.node.loc) continue
        const critical = !TAG_CALLED.test(method) && takesValues(startOf(built.node)) && node.arguments.length === 1
        addBuilt(queries, built.node.loc.start.line, built.node.loc.end.line, { method, how: built.how, critical })
      }
    }
  })
  return queries
}

// Without a syntax tree, Prisma's raw queries as the text has them: the method, a type argument
// if it has one, then a template or a call. A regex literal with a quote in it, as in
// .replace(/'/g, "''"), isn't understood, and a query with one is left to the patterns above, as
// is an argument that's a `?:` or a constant. The other tags stay with TAGGED_TEMPLATE_PREFIX, a
// line at a time
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
