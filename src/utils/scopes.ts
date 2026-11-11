import type { Node } from '@babel/types'

/** What a file sets a name to */
export interface Binding {
  /**
   * Each value the name is declared with or assigned, in source order: `append` is a `+=`, any
   * other assignment sets it. What the file doesn't show isn't here: a parameter, an import, a
   * loop's variable and a destructured value have no value of their own
   */
  values: { node: Node; append: boolean }[]
}

interface Scope {
  names: Map<string, Binding>
  parent: Scope | null
  /** A function's scope, or the module's: where a `var` lands, whatever block declares it */
  hoists: boolean
}

// What a `let` or a `const` is local to. A function's body is a block inside the scope of its
// parameters, which changes nothing: a body can't declare a parameter's name again
const BLOCKS = new Set(['BlockStatement', 'ForStatement', 'ForInStatement', 'ForOfStatement', 'SwitchStatement', 'CatchClause'])
// A class's static block and a namespace's body keep their `var`s, as a function does
const HOISTING_BLOCKS = new Set(['StaticBlock', 'TSModuleBlock'])

/** Every name a pattern declares: `x`, `{ a, b: [c] }`, `[d = 1, ...rest]` */
function declared(pattern: Node | null | undefined, names: string[] = []): string[] {
  switch (pattern?.type) {
    case 'Identifier': names.push(pattern.name); break
    case 'ObjectPattern': for (const p of pattern.properties) declared(p.type === 'RestElement' ? p.argument : p.value, names); break
    case 'ArrayPattern': for (const element of pattern.elements) declared(element, names); break
    case 'AssignmentPattern': declared(pattern.left, names); break
    case 'RestElement': declared(pattern.argument, names); break
    case 'TSParameterProperty': declared(pattern.parameter, names); break
  }
  return names
}

/** Depth-first, as walkAST goes, with the scope each node is in: `enter` returns its children's */
function walkScoped(node: Node, scope: Scope, enter: (node: Node, scope: Scope) => Scope): void {
  const inner = enter(node, scope)
  for (const key of Object.keys(node)) {
    if (key === 'start' || key === 'end' || key === 'loc' || key === 'type') continue
    const val = (node as any)[key]
    if (Array.isArray(val)) {
      for (const item of val) {
        if (item && typeof item === 'object' && item.type) walkScoped(item, inner, enter)
      }
    } else if (val && typeof val === 'object' && val.type) {
      walkScoped(val, inner, enter)
    }
  }
}

/**
 * Which declaration each of `names` refers to where it stands, with everything the file sets
 * that declaration to. `names` are Identifier nodes of the tree; one the file doesn't declare
 * (a global, a typo) isn't in the result.
 *
 * A name is looked up as JavaScript does: in its block, then each block and function around it,
 * then the module, so two functions' `query` are two names, and a parameter hides a module's
 * `const` of the same name. The order statements run in isn't read: a value counts wherever in
 * the name's scope it's set.
 */
export function bindNames(program: Node, names: ReadonlySet<Node>): Map<Node, Binding> {
  const scopes = new Map<Node, Scope>()
  const open = (node: Node, parent: Scope | null, hoists: boolean): Scope => {
    const scope: Scope = { names: new Map(), parent, hoists }
    scopes.set(node, scope)
    return scope
  }
  // Declared twice (`var`, or a `var` named as a parameter is), it's still one name. What
  // it's set to is read on the second walk, so declaring it again here loses nothing
  const declare = (scope: Scope, pattern: Node | null | undefined): void => {
    for (const name of declared(pattern)) scope.names.set(name, { values: [] })
  }
  const root = open(program, null, true)

  // Every declaration first: a name can be used above the line that declares it
  walkScoped(program, root, (node, scope) => {
    if (node === program) return scope
    if (node.type === 'VariableDeclaration') {
      let target = scope
      if (node.kind === 'var') while (!target.hoists && target.parent) target = target.parent
      for (const declarator of node.declarations) declare(target, declarator.id)
    } else if (node.type === 'ImportDeclaration') {
      for (const specifier of node.specifiers) declare(scope, specifier.local)
    } else if (node.type === 'ClassDeclaration' || node.type === 'TSEnumDeclaration' || node.type === 'TSModuleDeclaration' || node.type === 'TSImportEqualsDeclaration') {
      declare(scope, node.id)
    } else if (node.type === 'ClassExpression' && node.id) {
      // const A = class B {} names B for the class's own use
      const inner = open(node, scope, false)
      declare(inner, node.id)
      return inner
    } else if ('params' in node && 'body' in node) {
      // function f() {} is declared where it stands; const f = function g() {} names g for itself
      if (node.type === 'FunctionDeclaration') declare(scope, node.id)
      const inner = open(node, scope, true)
      if (node.type === 'FunctionExpression') declare(inner, node.id)
      for (const param of node.params) declare(inner, param)
      return inner
    } else if (HOISTING_BLOCKS.has(node.type)) {
      return open(node, scope, true)
    } else if (BLOCKS.has(node.type)) {
      const inner = open(node, scope, false)
      if (node.type === 'CatchClause') declare(inner, node.param)
      return inner
    }
    return scope
  })

  const lookup = (scope: Scope, name: string): Binding | null => {
    for (let s: Scope | null = scope; s; s = s.parent) {
      const binding = s.names.get(name)
      if (binding) return binding
    }
    return null
  }

  // Then what each name is set to, and which declaration the names asked for refer to
  const found = new Map<Node, Binding>()
  walkScoped(program, root, (node, scope) => {
    const inner = scopes.get(node) ?? scope
    if (node.type === 'VariableDeclarator') {
      if (node.id.type === 'Identifier' && node.init) lookup(inner, node.id.name)?.values.push({ node: node.init, append: false })
    } else if (node.type === 'AssignmentExpression') {
      if (node.left.type === 'Identifier') lookup(inner, node.left.name)?.values.push({ node: node.right, append: node.operator === '+=' })
    } else if (node.type === 'Identifier' && names.has(node)) {
      const binding = lookup(inner, node.name)
      if (binding) found.set(node, binding)
    }
    return inner
  })
  return found
}
