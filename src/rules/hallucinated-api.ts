import type { Node, CallExpression, OptionalCallExpression, MemberExpression, OptionalMemberExpression } from '@babel/types'
import type { Rule, Finding, FileContext, ProjectContext } from '../types.js'
import { isCommentLine } from '../utils/patterns.js'
import { isFrameworkSafeMethod } from '../utils/frameworks.js'

// The rule is for an array or a string given a method it doesn't have: `items.contains(x)`,
// `name.contains('a')`, `list.flatten()`. But .contains() and .flatten() are real methods of
// much else: DOM nodes and token lists, test runners, schema errors, query builders, lodash, a
// project's own classes. So each call is read from the syntax tree, in this order, and the
// first answer stands (`containsIsReal`, `flattenIsReal`):
// 1. the code checks for the method first (`a.contains?.(b)`, `'contains' in a ? …`), or the
//    file gives arrays or strings the method (a polyfill): real
// 2. what the file shows the receiver is (`kindOf`): an array or a string is reported whatever
//    it's handed; a class instance, `this`, a DOM list or a typed value is real
// 3. the call's shape: arguments an array's or a string's method doesn't take are another API's
// 4. what the receiver looks like: a library's chain, a DOM node (`isNode`), a zod error
// 5. the file defines the method itself: real. Otherwise, a receiver nothing is known about is
//    still reported. A file Babel can't parse gets the old text check, line by line.

type Member = MemberExpression | OptionalMemberExpression
type Call = CallExpression | OptionalCallExpression

/** One member call, with what's around it: `ancestors` runs from the program down to the call's parent */
interface CallSite {
  call: Call
  receiver: Node
  ancestors: Node[]
  file: FileReader
}

/** How a name came to be, as far as the file shows it */
interface Binding {
  kind: 'value' | 'import' | 'namespace' | 'function' | 'class' | 'catch' | 'rest'
  /** Its declared type: `: T` */
  type?: Node | null
  /** What it's set to where it's declared, or a parameter's default */
  init?: Node | null
  /** `const [items] = useState(…)`: that call */
  state?: Call
  /** A function's declared return type */
  returns?: Node | null
}

/**
 * What a value is, when the file shows it:
 * - `plain`: an array, a string or a built-in collection, which have neither method
 * - `own`: something that can have a method of its own (a DOM object, a class instance, `this`)
 * - null: nothing says
 */
type Kind = 'plain' | 'own' | null

// DOM token and string lists: an element's classList, relList and part (DOMTokenList),
// IndexedDB's objectStoreNames and indexNames (DOMStringList). They have .contains() and no
// .includes(). A variable keeps the name (`classList`, `targetClassList`); `part` is one only
// as a property, since `parts.filter(part => …)` is a string.
const DOM_LIST = /^(?:classList|relList|objectStoreNames|indexNames)$|ClassList$/
const DOM_LIST_PROPERTY = /^(?:classList|relList|part|objectStoreNames|indexNames)$|ClassList$/
// Properties the DOM keeps a node in: an event's target, a selection's anchorNode, a node's
// parent and children, a React ref's `current`, Angular's nativeElement
const NODE_PROPERTY = /^(?:target|currentTarget|relatedTarget|srcElement|activeElement|parentNode|parentElement|shadowRoot|ownerDocument|documentElement|firstChild|lastChild|firstElementChild|lastElementChild|nextSibling|previousSibling|nextElementSibling|previousElementSibling|anchorNode|focusNode|startContainer|endContainer|commonAncestorContainer|nativeElement|current)$/
// Calls that return a node
const NODE_CALL = /^(?:querySelector|getElementById|closest|createElement|createElementNS|elementFromPoint|getRootNode|cloneNode|findDOMNode|getDOMNode)$/
// Types a node is declared or cast as
const NODE_TYPE = /^(?:Node|ParentNode|ChildNode|Element|EventTarget|Document|DocumentFragment|ShadowRoot|HTML\w*Element|SVG\w*Element)$/
// How far a name goes in saying "a DOM node", for the three questions `containsIsReal` asks.
// What a variable is called says less about an argument than about a receiver: `outerNode` is
// asked something of its own, while `visited.contains(currentNode)` is a graph search.
// - the DOM's own words, kept by the variables they're read into: enough on either side
const DOM_NODE_NAME = /^(?:activeElement|relatedTarget|currentTarget)$/
// - a receiver named for a node: `menuEl`, `rootElement`, `outerNode`, `$el`
const NODE_NAME = /[a-z0-9_$](?:El|Elem|Element|Node)$|^(?:node|\$el|activeElement|relatedTarget|currentTarget)$/
// - names a node often has, and so does an item of an array (`list.filter(el => …)`) or what's
//   looked for (`nums.contains(target)`): they count only when both sides of the call have one
const MAYBE_NODE_NAME = /[a-z0-9_$](?:El|Elem|Element|Node)$|^(?:node|\$el|activeElement|relatedTarget|currentTarget|el|elem|element|target|child|parent|container|root|wrapper)$/

// Types with neither method. A value declared as one is what the rule is for.
const PLAIN_TYPE = /^(?:Array|ReadonlyArray|String|Set|ReadonlySet|Map|ReadonlyMap|WeakSet|WeakMap)$/
const PLAIN_CLASS = /^(?:Array|String|Set|Map|WeakSet|WeakMap|Object)$/
// Type names that say nothing about what's behind them: utility types, a schema's inferred
// type, a type parameter. Any other named type is the project's or a library's own.
const OPAQUE_TYPE = /^(?:Record|Partial|Required|Pick|Omit|Exclude|Extract|ReturnType|Awaited|Parameters|InstanceType|Promise|PromiseLike|infer|input|output|TypeOf|Infer\w*|[A-Z]|T[A-Z]\w*)$/
const WRAPPER_TYPE = /^(?:Readonly|NonNullable)$/
// Methods only a string has, which give a string or an array of them
const STRING_METHOD = /^(?:toLowerCase|toUpperCase|toLocaleLowerCase|toLocaleUpperCase|trim|trimStart|trimEnd|trimLeft|trimRight|substring|substr|padStart|padEnd|charAt|split|toString|join)$/
// Methods an array has that give an array: plain only when what they're called on is
// (a lodash wrapper and a stream have map() and filter() too)
const ARRAY_METHOD = /^(?:map|filter|slice|concat|flat|flatMap|sort|reverse|toSorted|toReversed|keys|values|entries)$/

// What lodash and underscore are called, as a wrapper `_(list)` or a chain `_.chain(list)`
const LODASH = /^(?:_|lodash|underscore)$/
// A schema validation error: zod's `error.flatten()`, on `parsed.error`, `error.cause` or `err`
const ERROR_NAME = /^(?:err|error|cause|exception)$|(?:Err|Error|Exception)$/
// What zod's flatten() returns, read straight off the call
const FLATTENED_ERROR_FIELD = /^(?:fieldErrors|formErrors)$/

const FUNCTION = /^(?:FunctionDeclaration|FunctionExpression|ArrowFunctionExpression|ObjectMethod|ClassMethod|ClassPrivateMethod)$/
const SCOPE = /^(?:Program|BlockStatement|StaticBlock|TSModuleBlock|ForStatement|ForInStatement|ForOfStatement|CatchClause|SwitchStatement)$/
const MAX_DEPTH = 6

const isMember = (node: Node): node is Member => node.type === 'MemberExpression' || node.type === 'OptionalMemberExpression'
const isCall = (node: Node): node is Call => node.type === 'CallExpression' || node.type === 'OptionalCallExpression'

/** A member's name when it's written out: `classList` in `el.classList` or `el["classList"]`, `#items` in `this.#items` */
function propertyName(member: Member): string | null {
  if (member.computed) return member.property.type === 'StringLiteral' ? member.property.value : null
  if (member.property.type === 'Identifier') return member.property.name
  if (member.property.type === 'PrivateName') return `#${member.property.id.name}`
  return null
}

/** Strip what wraps an expression without changing what it is: (x), x!, x as T. A cast's type is read first, where it matters. */
function bare(node: Node): Node {
  while (
    node.type === 'ParenthesizedExpression' || node.type === 'TSNonNullExpression' || node.type === 'TSAsExpression' ||
    node.type === 'TSSatisfiesExpression' || node.type === 'TSTypeAssertion'
  ) node = node.expression
  return node
}

/** The name an expression ends in: `target` for `e.target`, `get` for `cy.get('h1')` */
function lastName(node: Node): string | null {
  node = bare(node)
  if (node.type === 'Identifier') return node.name
  if (isMember(node)) return propertyName(node)
  if (isCall(node)) return lastName(node.callee)
  return null
}

function children(node: Node): Node[] {
  const out: Node[] = []
  for (const key of Object.keys(node)) {
    if (key === 'loc' || key === 'start' || key === 'end' || key === 'type' || key === 'extra' || key.endsWith('Comments')) continue
    const value = (node as unknown as Record<string, unknown>)[key]
    if (Array.isArray(value)) {
      for (const item of value) if (item && typeof item === 'object' && typeof (item as Node).type === 'string') out.push(item as Node)
    } else if (value && typeof value === 'object' && typeof (value as Node).type === 'string') out.push(value as Node)
  }
  return out
}

/** Depth-first walk that hands each node the chain of nodes above it */
function walk(node: Node, ancestors: Node[], visit: (node: Node, ancestors: Node[]) => void): void {
  visit(node, ancestors)
  ancestors.push(node)
  for (const child of children(node)) walk(child, ancestors, visit)
  ancestors.pop()
}

/** What one file declares, read on demand: most files never ask */
class FileReader {
  private scopes = new Map<Node, Map<string, Binding>>()
  private fields = new Map<Node, Map<string, Binding>>()
  private aliases: Map<string, Node> | null = null
  private defined = new Map<string, 'builtin' | 'own' | null>()
  private cypress: boolean | null = null

  constructor(private program: Node) {}

  /** The binding a name has at a call site: the nearest scope above it that declares the name */
  lookup(name: string, ancestors: Node[]): Binding | undefined {
    for (let i = ancestors.length - 1; i >= 0; i--) {
      const scope = ancestors[i]
      if (!SCOPE.test(scope.type) && !FUNCTION.test(scope.type)) continue
      const binding = this.declared(scope).get(name)
      if (binding) return binding
    }
    return undefined
  }

  /** `this.name`, as the class around the call declares it or its constructor sets it */
  field(name: string, ancestors: Node[]): Binding | undefined {
    for (let i = ancestors.length - 1; i >= 0; i--) {
      const body = ancestors[i]
      if (body.type !== 'ClassBody') continue
      let fields = this.fields.get(body)
      if (!fields) {
        fields = new Map()
        this.fields.set(body, fields)
        const add = (key: string, binding: Binding) => { if (!fields!.has(key)) fields!.set(key, binding) }
        for (const member of body.body) {
          if (member.type === 'ClassProperty' || member.type === 'ClassAccessorProperty' || member.type === 'ClassPrivateProperty') {
            const key = member.key.type === 'Identifier' ? member.key.name : member.key.type === 'PrivateName' ? `#${member.key.id.name}` : null
            if (key && (member.type === 'ClassPrivateProperty' || !member.computed)) add(key, { kind: 'value', type: typeOf(member), init: member.value })
          }
        }
        // constructor(private items: string[]) and `this.items = []` in its body
        for (const member of body.body) {
          if (member.type !== 'ClassMethod' || member.kind !== 'constructor') continue
          for (const param of member.params) {
            if (param.type === 'TSParameterProperty' && param.parameter.type === 'Identifier') add(param.parameter.name, { kind: 'value', type: typeOf(param.parameter) })
            else if (param.type === 'TSParameterProperty' && param.parameter.type === 'AssignmentPattern' && param.parameter.left.type === 'Identifier') {
              add(param.parameter.left.name, { kind: 'value', type: typeOf(param.parameter.left), init: param.parameter.right })
            }
          }
          for (const statement of member.body.body) {
            const set = statement.type === 'ExpressionStatement' ? statement.expression : null
            if (set?.type !== 'AssignmentExpression' || set.operator !== '=' || !isMember(set.left) || bare(set.left.object).type !== 'ThisExpression') continue
            const key = propertyName(set.left)
            if (key) add(key, { kind: 'value', init: set.right })
          }
        }
      }
      return fields.get(name)
    }
    return undefined
  }

  /** `type Tags = string[]` at the top of the file */
  alias(name: string): Node | undefined {
    if (!this.aliases) {
      this.aliases = new Map()
      for (const statement of this.program.type === 'Program' ? this.program.body : []) {
        const declaration = statement.type === 'ExportNamedDeclaration' && statement.declaration ? statement.declaration : statement
        if (declaration.type === 'TSTypeAliasDeclaration') this.aliases.set(declaration.id.name, declaration.typeAnnotation)
      }
    }
    return this.aliases.get(name)
  }

  /**
   * Does the file itself give something a method of this name?
   * - `own`: a class or an object has it, or an interface declares it. A call on something
   *   unknown is taken for theirs.
   * - `builtin`: arrays or strings are given it (`String.prototype.contains = …`, a polyfill),
   *   so here the call is real on them too.
   */
  defines(method: string): 'builtin' | 'own' | null {
    let found = this.defined.get(method)
    if (found !== undefined) return found
    found = null
    const named = (key: Node, computed?: boolean) =>
      (!computed && key.type === 'Identifier' && key.name === method) || (key.type === 'StringLiteral' && key.value === method)
    const isFunction = (value: Node | null | undefined) => value?.type === 'FunctionExpression' || value?.type === 'ArrowFunctionExpression'
    // String.prototype, Array.prototype
    const isBuiltinPrototype = (node: Node) =>
      isMember(node) && propertyName(node) === 'prototype' && PLAIN_CLASS.test(lastName(node.object) ?? '')
    const search = (node: Node): void => {
      if (found === 'builtin') return
      switch (node.type) {
        case 'ClassMethod': case 'ObjectMethod': case 'TSDeclareMethod': case 'TSMethodSignature':
          if (named(node.key, node.computed)) found = 'own'
          break
        case 'ClassProperty': case 'ObjectProperty':
          if (named(node.key, node.computed) && isFunction(node.value)) found = 'own'
          break
        case 'TSPropertySignature':
          if (named(node.key, node.computed) && node.typeAnnotation?.typeAnnotation.type === 'TSFunctionType') found = 'own'
          break
        case 'TSInterfaceDeclaration':
          // interface Array<T> { contains(item: T): boolean }
          if (PLAIN_TYPE.test(node.id.name) && node.body.body.some(member =>
            (member.type === 'TSMethodSignature' || member.type === 'TSPropertySignature') && named(member.key, member.computed))) found = 'builtin'
          break
        case 'AssignmentExpression':
          if (isMember(node.left) && propertyName(node.left) === method) found = isBuiltinPrototype(bare(node.left.object)) ? 'builtin' : 'own'
          break
        case 'CallExpression': {
          // Object.defineProperty(Array.prototype, 'contains', { … }), Object.assign(String.prototype, { contains() { … } }),
          // and MooTools' String.implement({ contains: … })
          const callee = bare(node.callee)
          const onBuiltin = node.arguments.some(argument => isBuiltinPrototype(bare(argument))) ||
            (isMember(callee) && /^(?:implement|extend|mixin)$/.test(propertyName(callee) ?? '') &&
              bare(callee.object).type === 'Identifier' && /^(?:Array|String)$/.test(lastName(callee.object) ?? ''))
          if (onBuiltin && node.arguments.some(argument =>
            (argument.type === 'StringLiteral' && argument.value === method) ||
            (argument.type === 'ObjectExpression' && argument.properties.some(property => property.type !== 'SpreadElement' && named(property.key, property.computed))))) found = 'builtin'
          break
        }
      }
      for (const child of children(node)) search(child)
    }
    search(this.program)
    this.defined.set(method, found)
    return found
  }

  /** A Cypress spec: the file calls into the `cy` global, so its helpers hand back Cypress chains */
  drivesCypress(): boolean {
    if (this.cypress === null) {
      const search = (node: Node): boolean =>
        (isMember(node) && node.object.type === 'Identifier' && node.object.name === 'cy') || children(node).some(search)
      this.cypress = !this.declared(this.program).has('cy') && search(this.program)
    }
    return this.cypress
  }

  private declared(scope: Node): Map<string, Binding> {
    let names = this.scopes.get(scope)
    if (names) return names
    names = new Map()
    this.scopes.set(scope, names)
    const add = (name: string, binding: Binding) => { if (!names!.has(name)) names!.set(name, binding) }
    const bind = (pattern: Node | null | undefined, binding: Binding): void => {
      if (!pattern) return
      switch (pattern.type) {
        case 'Identifier': add(pattern.name, { ...binding, type: typeOf(pattern) ?? binding.type }); break
        case 'AssignmentPattern': bind(pattern.left, { ...binding, init: pattern.right }); break
        case 'TSParameterProperty': bind(pattern.parameter, binding); break
        // `...rest` of parameters or of an array is an array
        case 'RestElement': bind(pattern.argument, { kind: 'rest' }); break
        case 'ArrayPattern': {
          // const [items, setItems] = useState<string[]>([])
          const call = binding.init ? bare(binding.init) : null
          const state = call && isCall(call) && lastName(call.callee) === 'useState' ? call : undefined
          pattern.elements.forEach((element, i) => bind(element, { kind: 'value', state: i === 0 ? state : undefined }))
          break
        }
        case 'ObjectPattern':
          // what's taken out of an object, and the rest of it, could be anything
          for (const property of pattern.properties) bind(property.type === 'RestElement' ? property.argument : property.value, { kind: 'value' })
          break
      }
    }
    const declare = (statement: Node): void => {
      switch (statement.type) {
        case 'ExportNamedDeclaration': case 'ExportDefaultDeclaration':
          if (statement.declaration) declare(statement.declaration)
          break
        case 'VariableDeclaration':
          for (const declarator of statement.declarations) bind(declarator.id, { kind: 'value', init: declarator.init })
          break
        case 'FunctionDeclaration': case 'TSDeclareFunction':
          if (statement.id) add(statement.id.name, { kind: 'function', returns: returnTypeOf(statement) })
          break
        case 'ClassDeclaration': case 'TSEnumDeclaration':
          if (statement.id) add(statement.id.name, { kind: 'class' })
          break
        case 'ImportDeclaration':
          for (const specifier of statement.specifiers) add(specifier.local.name, { kind: specifier.type === 'ImportNamespaceSpecifier' ? 'namespace' : 'import' })
          break
      }
    }

    if (FUNCTION.test(scope.type)) {
      for (const param of (scope as unknown as { params: Node[] }).params) bind(param, { kind: 'value' })
    } else if (scope.type === 'Program' || scope.type === 'BlockStatement' || scope.type === 'StaticBlock' || scope.type === 'TSModuleBlock') {
      for (const statement of scope.body) declare(statement)
    } else if (scope.type === 'ForStatement') {
      if (scope.init) declare(scope.init)
    } else if (scope.type === 'ForInStatement' || scope.type === 'ForOfStatement') {
      // the loop's variable is one item of what's looped over: nothing says what
      if (scope.left.type === 'VariableDeclaration') for (const declarator of scope.left.declarations) bind(declarator.id, { kind: 'value' })
    } else if (scope.type === 'CatchClause') {
      bind(scope.param, { kind: 'catch' })
    } else if (scope.type === 'SwitchStatement') {
      for (const switchCase of scope.cases) for (const statement of switchCase.consequent) declare(statement)
    }
    // `var` belongs to the function or the module, whatever block it's written in
    if (FUNCTION.test(scope.type) || scope.type === 'Program') {
      const hoist = (node: Node): void => {
        if (node !== scope && FUNCTION.test(node.type)) return
        if (node.type === 'VariableDeclaration' && node.kind === 'var') declare(node)
        for (const child of children(node)) hoist(child)
      }
      hoist(scope)
    }
    return names
  }
}

/** The type written on a name or a class property: `T` in `x: T` */
function typeOf(node: Node): Node | null {
  const annotation = (node as { typeAnnotation?: Node | null }).typeAnnotation
  return annotation?.type === 'TSTypeAnnotation' ? annotation.typeAnnotation : null
}

function returnTypeOf(fn: Node): Node | null {
  const annotation = (fn as { returnType?: Node | null }).returnType
  return annotation?.type === 'TSTypeAnnotation' ? annotation.typeAnnotation : null
}

/** What a declared type says a value is */
function typeKind(type: Node | null | undefined, file: FileReader, depth = 0): Kind {
  if (!type || depth > MAX_DEPTH) return null
  switch (type.type) {
    case 'TSStringKeyword': case 'TSArrayType': case 'TSTupleType': case 'TSTemplateLiteralType':
      return 'plain'
    case 'TSLiteralType':
      return type.literal.type === 'StringLiteral' || type.literal.type === 'TemplateLiteral' ? 'plain' : null
    case 'TSParenthesizedType': case 'TSOptionalType': case 'TSRestType':
      return typeKind(type.typeAnnotation, file, depth + 1)
    case 'TSTypeOperator':
      return type.operator === 'readonly' ? typeKind(type.typeAnnotation, file, depth + 1) : null
    case 'TSUnionType': {
      // `string | HTMLElement` may be a string; `HTMLElement | null` is an element
      const kinds = type.types.map(member => typeKind(member, file, depth + 1))
      return kinds.includes('plain') ? 'plain' : kinds.includes('own') ? 'own' : null
    }
    case 'TSImportType':
      return 'own'
    case 'TSTypeReference': {
      const qualified = type.typeName.type === 'TSQualifiedName'
      const name = type.typeName.type === 'TSQualifiedName' ? type.typeName.right.name : type.typeName.name
      if (OPAQUE_TYPE.test(name)) return null
      if (!qualified) {
        if (PLAIN_TYPE.test(name)) return 'plain'
        if (WRAPPER_TYPE.test(name)) return typeKind(type.typeParameters?.params[0], file, depth + 1)
        const alias = file.alias(name)
        if (alias) return typeKind(alias, file, depth + 1)
      }
      return 'own'
    }
    default:
      return null
  }
}

/** `c ? a : b`: plain if either side may be, else whatever one side says */
function either(a: Kind, b: Kind): Kind {
  return a === 'plain' || b === 'plain' ? 'plain' : a ?? b
}

/** What stands in for a value that isn't there: `[]`, `''`, `null`, `undefined` */
function isStandIn(node: Node): boolean {
  node = bare(node)
  return (node.type === 'ArrayExpression' && node.elements.length === 0) || (node.type === 'StringLiteral' && node.value === '') ||
    node.type === 'NullLiteral' || (node.type === 'Identifier' && node.name === 'undefined')
}

/** What an expression is, as far as the file shows it */
function kindOf(node: Node, site: CallSite, depth = 0): Kind {
  if (depth > MAX_DEPTH) return null
  const { file, ancestors } = site
  switch (node.type) {
    case 'ParenthesizedExpression': case 'TSNonNullExpression':
      return kindOf(node.expression, site, depth)
    case 'TSAsExpression': case 'TSSatisfiesExpression': case 'TSTypeAssertion':
      // `x as any` says nothing, so what's cast is read instead
      return typeKind(node.typeAnnotation, file) ?? kindOf(node.expression, site, depth)
    case 'AwaitExpression':
      return kindOf(node.argument, site, depth)
    case 'ArrayExpression': case 'StringLiteral': case 'TemplateLiteral':
      return 'plain'
    case 'BinaryExpression':
      return node.operator === '+' && (kindOf(node.left, site, depth + 1) === 'plain' || kindOf(node.right, site, depth + 1) === 'plain') ? 'plain' : null
    case 'ThisExpression': case 'Super':
      return 'own'
    case 'NewExpression':
      return node.callee.type === 'Identifier' && PLAIN_CLASS.test(node.callee.name) ? 'plain' : 'own'
    case 'ConditionalExpression':
      // `cond ? el.classList : []` is the list: an empty fallback only stands in for it
      if (isStandIn(node.alternate) !== isStandIn(node.consequent)) return kindOf(isStandIn(node.alternate) ? node.consequent : node.alternate, site, depth + 1)
      return either(kindOf(node.consequent, site, depth + 1), kindOf(node.alternate, site, depth + 1))
    case 'LogicalExpression':
      // `el.classList || []` is the list, `tags || []` an array: the left side is the value,
      // the right what stands in for it. `a && a.items` is its right side.
      return node.operator === '&&'
        ? kindOf(node.right, site, depth + 1)
        : kindOf(node.left, site, depth + 1) ?? kindOf(node.right, site, depth + 1)
    case 'Identifier': {
      const binding = file.lookup(node.name, ancestors)
      // `const { classList } = el` is still a token list
      const named = DOM_LIST.test(node.name) ? 'own' : null
      if (!binding) return node.name === 'document' ? 'own' : named
      return bindingKind(binding, site, depth) ?? named
    }
    case 'MemberExpression': case 'OptionalMemberExpression': {
      const name = propertyName(node)
      if (!name) return null
      if (DOM_LIST_PROPERTY.test(name)) return 'own'
      const object = bare(node.object)
      if (object.type === 'ThisExpression') {
        const field = file.field(name, ancestors)
        if (field) return bindingKind(field, site, depth)
      }
      return null
    }
    case 'CallExpression': case 'OptionalCallExpression': {
      const callee = bare(node.callee)
      // getBodyClassList()
      if (DOM_LIST.test(lastName(callee) ?? '')) return 'own'
      if (callee.type === 'Identifier') {
        if (callee.name === 'String') return 'plain'
        const binding = file.lookup(callee.name, ancestors)
        return binding?.kind === 'function' ? typeKind(binding.returns, file) : null
      }
      if (!isMember(callee)) return null
      // a step of a library's chain gives the library's object: _.chain(text).split('\n')
      if (isLibraryChain(node, site)) return 'own'
      const method = propertyName(callee)
      if (!method) return null
      const object = bare(callee.object)
      const global = object.type === 'Identifier' && !file.lookup(object.name, ancestors) ? object.name : null
      if (global === 'Object' && /^(?:keys|values|entries|getOwnPropertyNames)$/.test(method)) return 'plain'
      if (global === 'Array' && /^(?:from|of)$/.test(method)) return 'plain'
      if (global === 'JSON' && method === 'stringify') return 'plain'
      // a library's trim() or join() gives its own object back: sharp(input).trim(), knex(table).join(…)
      if (STRING_METHOD.test(method)) return /^(?:trim|join)$/.test(method) && isCall(object) && kindOf(object, site, depth + 1) !== 'plain' ? null : 'plain'
      if (NODE_CALL.test(method)) return 'own'
      if (ARRAY_METHOD.test(method)) return kindOf(object, site, depth + 1) === 'plain' ? 'plain' : null
      return null
    }
    default:
      return null
  }
}

function bindingKind(binding: Binding, site: CallSite, depth: number): Kind {
  switch (binding.kind) {
    case 'rest': return 'plain'
    // a function, a class, an enum or a module's namespace isn't an array or a string
    case 'function': case 'class': case 'namespace': return 'own'
    case 'import': case 'catch': return null
  }
  const declared = typeKind(binding.type, site.file)
  if (declared) return declared
  if (binding.state) {
    // const [items, setItems] = useState<string[]>([])
    const typed = typeKind(binding.state.typeParameters?.params[0], site.file)
    if (typed) return typed
    const initial = binding.state.arguments[0]
    return initial ? kindOf(initial, site, depth + 1) : null
  }
  return binding.init ? kindOf(binding.init, site, depth + 1) : null
}

/**
 * Is this a DOM node? By what the file shows (a DOM property, call, type or cast, or a variable
 * set to one), or else by a name that `names` takes for a node's.
 */
function isNode(node: Node, site: CallSite, names: RegExp, depth = 0): boolean {
  if (depth > MAX_DEPTH) return false
  switch (node.type) {
    case 'ParenthesizedExpression': case 'TSNonNullExpression':
      return isNode(node.expression, site, names, depth)
    case 'TSAsExpression': case 'TSSatisfiesExpression': case 'TSTypeAssertion':
      return isNodeType(node.typeAnnotation) || isNode(node.expression, site, names, depth)
    case 'ConditionalExpression':
      return isNode(node.consequent, site, names, depth + 1) || isNode(node.alternate, site, names, depth + 1)
    case 'LogicalExpression':
      return isNode(node.left, site, names, depth + 1) || isNode(node.right, site, names, depth + 1)
    case 'Identifier': {
      const binding = site.file.lookup(node.name, site.ancestors)
      if (!binding) return node.name === 'document' || names.test(node.name)
      if (binding.kind === 'value') {
        if (isNodeType(binding.type)) return true
        // what a variable is set to is read as a receiver is: `const target = menuEl`
        if (binding.init && isNode(binding.init, site, NODE_NAME, depth + 1)) return true
      }
      // a name says nothing once the file shows the value is an array, a string, a function or a class
      if (binding.kind === 'function' || binding.kind === 'class' || bindingKind(binding, site, depth + 1) === 'plain') return false
      return names.test(node.name)
    }
    case 'MemberExpression': case 'OptionalMemberExpression': {
      const name = propertyName(node)
      if (!name) return false
      if (NODE_PROPERTY.test(name) || names.test(name)) return true
      return /^(?:body|head)$/.test(name) && lastName(node.object) === 'document'
    }
    case 'CallExpression': case 'OptionalCallExpression':
      return NODE_CALL.test(lastName(node.callee) ?? '')
    default:
      return false
  }
}

function isNodeType(type: Node | null | undefined): boolean {
  if (!type) return false
  if (type.type === 'TSUnionType') return type.types.some(isNodeType)
  if (type.type === 'TSIntersectionType') return type.types.some(isNodeType)
  return type.type === 'TSTypeReference' && type.typeName.type === 'Identifier' && NODE_TYPE.test(type.typeName.name)
}

/**
 * A chain that starts in a library, so what it ends in is the library's: a test runner's
 * (`cy.get('h1').contains('About')`, chai's and TestCafe's `expect(x).contains(y)`, a Cypress
 * spec's page helper `getGreeting().contains('Welcome')`) or a lodash or underscore wrapper's
 * (`_(list).map(f).flatten()`, `lodash.chain(list).contains(x)`). `_.map(list, f).flatten()`
 * isn't one: that map() gives a plain array.
 */
function isLibraryChain(node: Node, site: CallSite): boolean {
  for (let current = bare(node); ; ) {
    if (isCall(current)) {
      const callee = bare(current.callee)
      if (lastName(callee) === 'expect') return true
      if (callee.type === 'Identifier') {
        if (LODASH.test(callee.name)) return true
        return site.file.lookup(callee.name, site.ancestors)?.kind === 'import' && site.file.drivesCypress()
      }
      if (isMember(callee) && propertyName(callee) === 'chain' && LODASH.test(lastName(callee.object) ?? '')) return true
      current = callee
    } else if (isMember(current)) current = bare(current.object)
    else return current.type === 'Identifier' && current.name === 'cy' && !site.file.lookup('cy', site.ancestors)
  }
}

/** Two references to one thing: `a` and `a`, `this.el` and `this.el` */
function sameRef(a: Node, b: Node): boolean {
  a = bare(a)
  b = bare(b)
  if (a.type === 'Identifier' && b.type === 'Identifier') return a.name === b.name
  if (a.type === 'ThisExpression' && b.type === 'ThisExpression') return true
  if (!isMember(a) || !isMember(b)) return false
  const name = propertyName(a)
  return name !== null && name === propertyName(b) && sameRef(a.object, b.object)
}

/** Does `test` check that `receiver` has the method: `'contains' in a`, `typeof a.contains === 'function'`, `a.contains`? */
function checksFor(test: Node, receiver: Node, method: string): boolean {
  test = bare(test)
  const isMethod = (node: Node) => {
    node = bare(node)
    return isMember(node) && propertyName(node) === method && sameRef(node.object, receiver)
  }
  if (test.type === 'LogicalExpression') return test.operator === '&&' && (checksFor(test.left, receiver, method) || checksFor(test.right, receiver, method))
  if (isMethod(test)) return true
  if (test.type !== 'BinaryExpression') return false
  if (test.operator === 'in') return test.left.type === 'StringLiteral' && test.left.value === method && sameRef(test.right, receiver)
  if (test.operator !== '==' && test.operator !== '===') return false
  const typeOfMethod = (node: Node) => node.type === 'UnaryExpression' && node.operator === 'typeof' && isMethod(node.argument)
  const isFunctionWord = (node: Node) => node.type === 'StringLiteral' && node.value === 'function'
  return (typeOfMethod(test.left) && isFunctionWord(test.right)) || (typeOfMethod(test.right) && isFunctionWord(test.left))
}

/**
 * The call runs only once the code has checked the method is there, as an optional call does:
 * `'contains' in a ? a.contains(b) : …`, `if (typeof list.flatten === 'function') list.flatten()`
 */
function isGuarded(site: CallSite, method: string): boolean {
  const { ancestors, call, receiver } = site
  for (let i = ancestors.length - 1; i >= 0; i--) {
    const node = ancestors[i]
    const child = ancestors[i + 1] ?? call
    if ((node.type === 'ConditionalExpression' || node.type === 'IfStatement') && child === node.consequent && checksFor(node.test, receiver, method)) return true
    if (node.type === 'LogicalExpression' && node.operator === '&&' && child === node.right && checksFor(node.left, receiver, method)) return true
  }
  return false
}

/** Text, as written: a string, a template, or a string joined to something */
function isText(node: Node): boolean {
  node = bare(node)
  if (node.type === 'StringLiteral' || node.type === 'TemplateLiteral') return true
  return node.type === 'BinaryExpression' && node.operator === '+' && (isText(node.left) || isText(node.right))
}

/**
 * .contains() is real here. An array's or a string's, as Java, C# and Kotlin have it, takes the
 * one value to look for. Two arguments are a query builder's (column, value) or a library's
 * (list, value). And something made on the spot (an object, an array, a regex, an element, a
 * function) is never in an array that `.includes()` compares by identity, nor in a string.
 */
function containsIsReal(site: CallSite): boolean {
  const { call, receiver, file } = site
  // `list.contains?.(x)`: whoever wrote it allows for the method not being there
  if (call.optional || isGuarded(site, 'contains')) return true
  // the file gives arrays or strings the method: `String.prototype.contains = …`
  const defined = file.defines('contains')
  if (defined === 'builtin') return true
  // what the file shows it's called on decides, whatever it's handed: `str.contains('a', 1)`
  const kind = kindOf(receiver, site)
  if (kind) return kind === 'own'

  if (call.arguments.length !== 1) return true
  const [argument] = call.arguments
  if (/^(?:SpreadElement|ObjectExpression|ArrayExpression|RegExpLiteral|NewExpression|JSXElement|JSXFragment|ArrowFunctionExpression|FunctionExpression)$/.test(bare(argument).type)) return true
  if (isLibraryChain(receiver, site)) return true
  // Node.contains(node): a node isn't asked for a string
  if (!isText(argument)) {
    if (isNode(receiver, site, NODE_NAME) || isNode(argument, site, DOM_NODE_NAME)) return true
    if (isNode(receiver, site, MAYBE_NODE_NAME) && isNode(argument, site, MAYBE_NODE_NAME)) return true
  }
  // nothing says what it's called on, and the file gives something a contains() of its own
  return defined === 'own'
}

/**
 * .flatten() is real here. An array's, as Ruby and the first draft of .flat() had it, takes
 * nothing or a depth. Anything else is a function handed what to flatten, or its options:
 * `_.flatten(list)`, `StyleSheet.flatten(style)`, `sharp(file).flatten({ background })`.
 */
function flattenIsReal(site: CallSite): boolean {
  const { call, receiver, ancestors, file } = site
  if (call.optional || isGuarded(site, 'flatten')) return true
  // `Array.prototype.flatten = …`
  const defined = file.defines('flatten')
  if (defined === 'builtin') return true
  const kind = kindOf(receiver, site)
  if (kind) return kind === 'own'

  const [depth] = call.arguments
  const isDepth = depth && (depth.type === 'NumericLiteral' || (depth.type === 'Identifier' && depth.name === 'Infinity'))
  if (call.arguments.length > 1 || (depth && !isDepth)) return true
  // error.flatten().fieldErrors
  const parent = ancestors[ancestors.length - 1]
  if (parent && isMember(parent) && parent.object === call && FLATTENED_ERROR_FIELD.test(propertyName(parent) ?? '')) return true
  if (isLibraryChain(receiver, site)) return true
  // a schema validation error: `parsed.error.flatten()`, `error.cause.flatten()`, `catch (e) { e.flatten() }`
  const name = bare(receiver)
  if (ERROR_NAME.test(lastName(name) ?? '') && !isCall(name)) return true
  if (name.type === 'Identifier' && file.lookup(name.name, ancestors)?.kind === 'catch') return true
  return defined === 'own'
}

/** `x.<method>(…)` where the receiver ends in a name: `response.body` in `response.body.json()` */
function receiverEndsWith(site: CallSite, names: RegExp[]): boolean {
  let node = bare(site.receiver)
  for (let i = names.length - 1; i >= 0; i--) {
    if (!names[i].test(lastName(node) ?? '') || isCall(node)) return false
    if (i > 0) {
      if (!isMember(node)) return false
      node = bare(node.object)
    }
  }
  return true
}

interface Api {
  /** The member called: `x.<method>(…)` */
  method: string
  fix: string
  /** The call isn't the hallucinated one, by what it's made on and how */
  isReal?: (site: CallSite) => boolean
  /** A file Babel can't parse is matched as text: the call, and whether it's real given the code before and after it */
  pattern: RegExp
  isRealText?: (before: string, after: string) => boolean
}

// The text check's stand-ins for the above, from one line: the usual shapes of a DOM receiver
// or argument, a test chain, a schema error, and a flatten() that is handed something
const TEXT_DOM_RECEIVER = /(?:\b(?:classList|relList|objectStoreNames|indexNames)|\.current|\bdocument(?:\.(?:body|documentElement|head))?)\??$/
const TEXT_DOM_ARGUMENT = /^\s*(?:[\w$.?]*\.(?:target|relatedTarget|currentTarget|activeElement)\b|[^)]*\bas\s+(?:Node|Element|HTML\w*Element)\b)/
const TEXT_TEST_CHAIN = /(?:^|[^\w$.])(?:cy\s*\.|expect\s*\()/
// `parsed.error`, `error.cause`, `(e as ZodError)`
const TEXT_ERROR_RECEIVER = /(?:\b(?:err|error|cause|exception)|Err|Error|Exception)\)?\??$/
const TEXT_FLATTENED_ERROR = /^\s*\)\s*\??\.\s*(?:fieldErrors|formErrors)\b/
// A line that ends inside the call's parentheses hands it what's on the next lines
const TEXT_DEPTH_OR_NOTHING = /^\s*(?:\d+|Infinity)?\s*\)/

// In each pattern, `(?<!\.\.)` keeps the last dot of a spread from reading as a member access:
// `...flatten(x)` calls a function named flatten
const HALLUCINATED_APIS: Api[] = [
  {
    method: 'flatten',
    fix: 'Use .flat() instead of .flatten()',
    isReal: flattenIsReal,
    pattern: /(?<!\.\.)\.flatten\s*\(/,
    isRealText: (before, after) => !TEXT_DEPTH_OR_NOTHING.test(after) || TEXT_ERROR_RECEIVER.test(before) || TEXT_FLATTENED_ERROR.test(after),
  },
  {
    method: 'contains',
    fix: 'Use .includes() instead of .contains() on arrays and strings — DOM classList and Node .contains() are valid',
    isReal: containsIsReal,
    pattern: /(?<!\.\.)\.contains\s*\(/,
    isRealText: (before, after) => TEXT_DOM_RECEIVER.test(before) || TEXT_DOM_ARGUMENT.test(after) || TEXT_TEST_CHAIN.test(before),
  },
  { method: 'substr', fix: 'Use .substring() or .slice() instead of deprecated .substr()', pattern: /(?<!\.\.)\.substr\s*\(/ },
  { method: 'trimLeft', fix: 'Use .trimStart() instead of deprecated .trimLeft()', pattern: /(?<!\.\.)\.trimLeft\s*\(/ },
  { method: 'trimRight', fix: 'Use .trimEnd() instead of deprecated .trimRight()', pattern: /(?<!\.\.)\.trimRight\s*\(/ },
  {
    method: 'json',
    fix: 'Use response.json() instead of response.body.json()',
    isReal: site => !receiverEndsWith(site, [/response$/, /^body$/]),
    pattern: /response\.body\.json\s*\(/,
  },
  {
    method: 'abort',
    fix: 'Use AbortController instead of fetch.abort()',
    isReal: site => !receiverEndsWith(site, [/fetch$/]),
    pattern: /fetch\.abort\s*\(/,
  },
  {
    method: 'isArray',
    fix: 'Array.isArray() is static — use Array.isArray(value)',
    isReal: site => site.call.arguments.length > 0,
    pattern: /(?<!\.\.)\.isArray\s*\(\s*\)/,
  },
  {
    method: 'hasOwnProperty',
    fix: 'Use Object.hasOwn() instead of .hasOwnProperty()',
    isReal: site => receiverEndsWith(site, [/Object$/, /^prototype$/]),
    pattern: /(?<!Object\.prototype)(?<!\.\.)\.hasOwnProperty\s*\(/,
  },
]
const API_BY_METHOD = new Map(HALLUCINATED_APIS.map((api, order) => [api.method, { api, order }]))
const ANY_METHOD = new RegExp(HALLUCINATED_APIS.map(api => api.method).join('|'))

function finding(file: FileContext, line: number, column: number, api: Api): Finding {
  return {
    ruleId: 'hallucinated-api',
    file: file.relativePath,
    line,
    column,
    message: api.fix,
    severity: 'warning',
    category: 'ai-quality',
    fix: api.fix,
  }
}

/** Every member call of a listed method that nothing shows to be real: one finding a line for each method */
function checkCalls(file: FileContext, program: Node, frameworks: Set<string>): Finding[] {
  const reader = new FileReader(program)
  const found = new Map<string, { line: number; column: number; order: number; api: Api }>()

  walk(program, [], (node, ancestors) => {
    if (!isCall(node)) return
    const callee = node.callee
    if (!isMember(callee) || callee.computed || callee.property.type !== 'Identifier' || !callee.property.loc) return
    const entry = API_BY_METHOD.get(callee.property.name)
    if (!entry) return
    // Skip if this method is legitimate for a detected framework
    if (isFrameworkSafeMethod(entry.api.method, frameworks)) return
    if (entry.api.isReal?.({ call: node, receiver: callee.object, ancestors, file: reader })) return

    // Where the text check puts it, on the dot before the name: the name's 0-based column is
    // the dot's 1-based one. One finding a line for each method, as the text check gives.
    const { line, column } = callee.property.loc.start
    const key = `${line}:${entry.order}`
    const earlier = found.get(key)
    if (!earlier || column < earlier.column) found.set(key, { line, column, order: entry.order, api: entry.api })
  })

  return [...found.values()]
    .sort((a, b) => a.line - b.line || a.order - b.order)
    .map(({ line, column, api }) => finding(file, line, column, api))
}

/** The text check, for a file Babel can't parse: one line at a time */
function checkLines(file: FileContext, frameworks: Set<string>): Finding[] {
  const findings: Finding[] = []

  for (let i = 0; i < file.lines.length; i++) {
    if (isCommentLine(file.lines, i, file.commentMap)) continue
    const line = file.lines[i]

    for (const api of HALLUCINATED_APIS) {
      const match = api.pattern.exec(line)
      if (!match) continue
      // Skip if this method is legitimate for a detected framework
      if (isFrameworkSafeMethod(api.method, frameworks)) continue
      // ...or for what it's called on and with
      if (api.isRealText?.(line.slice(0, match.index), line.slice(match.index + match[0].length))) continue
      findings.push(finding(file, i + 1, match.index + 1, api))
    }
  }

  return findings
}

export const hallucinatedApiRule: Rule = {
  id: 'hallucinated-api',
  name: 'Hallucinated API',
  description: 'Detects non-existent or deprecated JavaScript/DOM APIs often generated by AI',
  category: 'ai-quality',
  severity: 'warning',
  fileExtensions: ['ts', 'tsx', 'js', 'jsx'],

  check(file: FileContext, project: ProjectContext): Finding[] {
    if (!ANY_METHOD.test(file.content)) return []
    const frameworks = project.detectedFrameworks

    if (file.ast) {
      try {
        return checkCalls(file, file.ast.program, frameworks)
      } catch {
        // The walk failed (a file nested too deep): fall through to the text check
      }
    }
    return checkLines(file, frameworks)
  },
}
