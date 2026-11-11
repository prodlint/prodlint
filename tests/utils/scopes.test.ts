import { describe, it, expect } from 'vitest'
import { parseFile, walkAST } from '../../src/utils/ast.js'
import { bindNames } from '../../src/utils/scopes.js'
import type { Node } from '@babel/types'

/**
 * What each `use(name)` in the code is handed, in source order: the values the file sets that
 * declaration to, as written, `+=` marked, or null for a name the file doesn't declare
 */
function held(code: string, fileName = 'test.ts'): (string[] | null)[] {
  const ast = parseFile(code, fileName)
  if (!ast) throw new Error('the test code does not parse')
  const names: Node[] = []
  walkAST(ast.program, (node) => {
    if (node.type === 'CallExpression' && node.callee.type === 'Identifier' && node.callee.name === 'use') names.push(node.arguments[0])
  })
  const bound = bindNames(ast.program, new Set(names))
  return names.map((name) => {
    const binding = bound.get(name)
    return binding ? binding.values.map(v => (v.append ? '+= ' : '') + code.slice(v.node.start!, v.node.end!)) : null
  })
}

describe('bindNames', () => {
  it('reads what a const, a let and a var are declared with', () => {
    expect(held("const a = 'x'\nlet b = 1 + 2\nvar c = f()\nuse(a); use(b); use(c)")).toEqual([["'x'"], ['1 + 2'], ['f()']])
  })

  it('reads every assignment, in source order, and marks a +=', () => {
    const code = [
      'let sql: string',
      "sql = 'a'",
      "sql += 'b'",
      "sql ||= 'c'",
      "sql ??= 'd'",
      'use(sql)',
    ].join('\n')
    expect(held(code)).toEqual([["'a'", "+= 'b'", "'c'", "'d'"]])
  })

  it('leaves out a name the file does not declare', () => {
    expect(held("use(missing)\nmissing = 'x'")).toEqual([null])
  })

  it.each([
    ['a parameter', 'function f(x) { use(x) }'],
    ['a parameter with a default', "function f(x = 'd') { use(x) }"],
    ['a rest parameter', 'function f(...x) { use(x) }'],
    ["an arrow function's parameter", 'const f = x => use(x)'],
    ["a method's parameter", 'class A { m(x) { use(x) } }'],
    ["an object method's parameter", 'const o = { m(x) { use(x) } }'],
    ["a constructor's parameter property", 'class A { constructor(private x: string) { use(x) } }'],
    ['an import', "import x from 'x'\nuse(x)"],
    ['a named import', "import { y as x } from 'x'\nuse(x)"],
    ['a namespace import', "import * as x from 'x'\nuse(x)"],
    ['an import = require()', "import x = require('x')\nuse(x)"],
    ["a loop's variable", 'for (const x of xs) use(x)'],
    ["a for…in loop's variable", 'for (const x in xs) use(x)'],
    ['a destructured value', 'const { x } = y\nuse(x)'],
    ['a renamed and nested destructured value', 'const { a: [x = 1, ...rest] } = y\nuse(x)'],
    ['a rest element', 'const [first, ...x] = y\nuse(x)'],
    ["an object pattern's rest", 'const { first, ...x } = y\nuse(x)'],
    ["a catch clause's parameter", 'try { f() } catch (x) { use(x) }'],
    ['a function', 'function x() {}\nuse(x)'],
    ['a class', 'class x {}\nuse(x)'],
    ['an enum', 'enum x { A }\nuse(x)'],
    ['a namespace', 'namespace x { export const a = 1 }\nuse(x)'],
  ])('declares %s, with no value the file shows', (_what, code) => {
    expect(held(code)).toEqual([[]])
  })

  it('hides an outer name behind each of those', () => {
    const outer = "const x = 'outer'\n"
    expect(held(outer + 'function f(x) { use(x) }\nuse(x)')).toEqual([[], ["'outer'"]])
    expect(held(outer + 'for (const x of xs) { use(x) }\nuse(x)')).toEqual([[], ["'outer'"]])
    expect(held(outer + 'try { f() } catch (x) { use(x) }\nuse(x)')).toEqual([[], ["'outer'"]])
    expect(held(outer + 'function f() { const { x } = y; use(x) }\nuse(x)')).toEqual([[], ["'outer'"]])
  })

  it('keeps a let to its block', () => {
    const code = [
      "let x = 'outer'",
      '{',
      "  let x = 'inner'",
      '  use(x)',
      '}',
      'use(x)',
    ].join('\n')
    expect(held(code)).toEqual([["'inner'"], ["'outer'"]])
  })

  it('keeps an assignment to the declaration it reaches', () => {
    const code = [
      "let x = 'outer'",
      'function f() {',
      "  let x = 'inner'",
      "  x = 'inner too'",
      '  use(x)',
      '}',
      'function g() {',
      "  x += 'more'",
      '}',
      'use(x)',
    ].join('\n')
    expect(held(code)).toEqual([["'inner'", "'inner too'"], ["'outer'", "+= 'more'"]])
  })

  it('lifts a var out of its blocks, not out of its function', () => {
    const code = [
      "var x = 'module'",
      'function f() {',
      '  if (a) {',
      "    for (;;) { var x = 'function' }",
      '  }',
      '  use(x)',
      '}',
      'use(x)',
    ].join('\n')
    expect(held(code)).toEqual([["'function'"], ["'module'"]])
  })

  it('makes one name of a var declared twice, or named as a parameter is', () => {
    expect(held("function f() { var x = 'a'; var x = 'b'; use(x) }")).toEqual([["'a'", "'b'"]])
    expect(held("function f(x) { var x = x || 'd'; use(x) }")).toEqual([["x || 'd'"]])
  })

  it('finds a name used above its declaration, or assigned there', () => {
    const code = [
      'function f() {',
      "  x = 'set above'",
      '  use(x)',
      '}',
      "let x = 'declared'",
    ].join('\n')
    expect(held(code)).toEqual([["'set above'", "'declared'"]])
  })

  it("scopes a for loop's let, a switch and a catch", () => {
    const outer = "const x = 'outer'\n"
    expect(held(outer + "for (let x = 'loop'; ;) { use(x) }\nuse(x)")).toEqual([["'loop'"], ["'outer'"]])
    expect(held(outer + 'for (const x in xs) use(x)\nuse(x)')).toEqual([[], ["'outer'"]])
    expect(held(outer + 'for (const x of xs) use(x)\nuse(x)')).toEqual([[], ["'outer'"]])
    expect(held(outer + "switch (k) { case 1: { break } default: let x = 'switch'; use(x) }\nuse(x)")).toEqual([["'switch'"], ["'outer'"]])
    expect(held(outer + "try { f() } catch { let x = 'catch'; use(x) }\nuse(x)")).toEqual([["'catch'"], ["'outer'"]])
  })

  it('declares a function where it stands, and a function or class expression for itself', () => {
    const outer = "const x = 'outer'\n"
    expect(held(outer + 'const f = function x() { use(x) }\nuse(x)')).toEqual([[], ["'outer'"]])
    expect(held(outer + 'const C = class x { m() { use(x) } }\nuse(x)')).toEqual([[], ["'outer'"]])
    expect(held(outer + '{ function x() {} use(x) }\nuse(x)')).toEqual([[], ["'outer'"]])
  })

  it('reads a default value and a type where they stand', () => {
    const outer = "const x = 'outer'\n"
    // The default is read outside the function's body, and a type alias isn't a value
    expect(held(outer + "function f(a = use(x)) { let x = 'body' }")).toEqual([["'outer'"]])
    expect(held(outer + 'function f() { type x = string; use(x) }')).toEqual([["'outer'"]])
  })

  it("keeps a var to a class's static block and to a namespace", () => {
    const outer = "var x = 'outer'\n"
    expect(held(outer + "class A { static { var x = 'static'; use(x) } }\nuse(x)")).toEqual([["'static'"], ["'outer'"]])
    expect(held(outer + "namespace N { var x = 'namespace'; use(x) }\nuse(x)")).toEqual([["'namespace'"], ["'outer'"]])
  })

  it('counts no value for what an assignment destructures, a loop sets or an update changes', () => {
    const code = [
      "let x = 'a';",
      '[x, y] = pair;',
      '({ x } = record);',
      'for (x of xs) {}',
      'x++;',
      'use(x)',
    ].join('\n')
    expect(held(code)).toEqual([["'a'"]])
  })

  it('does not take a property or a label for the name', () => {
    const code = [
      "const x = 'a'",
      "o.x = 'property'",
      "x: for (;;) { break x }",
      'use(x)',
    ].join('\n')
    expect(held(code, 'test.js')).toEqual([["'a'"]])
  })

  it('reads plain JavaScript, JSX included', () => {
    expect(held("let x = 'a'\nconst el = <a onClick={() => { x = 'b'; use(x) }} />", 'test.jsx')).toEqual([["'a'", "'b'"]])
  })
})
