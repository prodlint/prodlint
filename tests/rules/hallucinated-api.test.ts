import { describe, it, expect } from 'vitest'
import { hallucinatedApiRule } from '../../src/rules/hallucinated-api.js'
import { makeFile, makeProject } from '../helpers.js'

const project = makeProject()

/** Where the rule reports, for each finding: `line:column` */
function reported(code: string, opts: { relativePath?: string; withAst?: boolean } = {}): string[] {
  return hallucinatedApiRule.check(makeFile(code, opts), project).map(f => `${f.line}:${f.column}`)
}

/** Where a finding for each call goes: its line, and the column of the dot before the method, as the text check had it */
function at(code: string, ...calls: string[]): string[] {
  const lines = code.split('\n')
  return calls.map(call => {
    const line = lines.findIndex(l => l.includes(call))
    if (line === -1) throw new Error(`not in the code: ${call}`)
    return `${line + 1}:${lines[line].indexOf(call) + call.lastIndexOf('.') + 1}`
  })
}

describe('hallucinated-api rule', () => {
  it('detects .flatten() → .flat()', () => {
    const file = makeFile(`const flat = arr.flatten()`)
    const findings = hallucinatedApiRule.check(file, project)
    expect(findings).toHaveLength(1)
    expect(findings[0].message).toContain('.flat()')
  })

  it('detects .contains() → .includes()', () => {
    const file = makeFile(`if (arr.contains(x)) {}`)
    const findings = hallucinatedApiRule.check(file, project)
    expect(findings).toHaveLength(1)
    expect(findings[0].message).toContain('.includes()')
  })

  it('detects .substr()', () => {
    const file = makeFile(`const sub = str.substr(0, 5)`)
    const findings = hallucinatedApiRule.check(file, project)
    expect(findings).toHaveLength(1)
    expect(findings[0].message).toContain('.substring()')
  })

  it('detects .trimLeft()', () => {
    const file = makeFile(`const trimmed = str.trimLeft()`)
    const findings = hallucinatedApiRule.check(file, project)
    expect(findings).toHaveLength(1)
    expect(findings[0].message).toContain('.trimStart()')
  })

  it('detects response.body.json()', () => {
    const file = makeFile(`const data = response.body.json()`)
    const findings = hallucinatedApiRule.check(file, project)
    expect(findings).toHaveLength(1)
    expect(findings[0].message).toContain('response.json()')
  })

  it('ignores correct APIs', () => {
    const file = makeFile(`const flat = arr.flat()\nconst has = arr.includes(x)`)
    const findings = hallucinatedApiRule.check(file, project)
    expect(findings).toHaveLength(0)
  })

  // Framework whitelisting tests
  it('skips .contains() when Prisma is detected', () => {
    const prismaProject = makeProject({ detectedFrameworks: new Set(['prisma']) })
    const file = makeFile(`const users = await prisma.user.findMany({ where: { name: { contains: 'test' } } })`)
    const findings = hallucinatedApiRule.check(file, prismaProject)
    expect(findings).toHaveLength(0)
  })

  it('skips .contains() when Supabase is detected', () => {
    const supabaseProject = makeProject({ detectedFrameworks: new Set(['supabase']) })
    const file = makeFile(`const { data } = await supabase.from('items').select().contains('tags', ['a'])`)
    const findings = hallucinatedApiRule.check(file, supabaseProject)
    expect(findings).toHaveLength(0)
  })

  it('skips .flatten() when lodash is detected', () => {
    const lodashProject = makeProject({ detectedFrameworks: new Set(['lodash']) })
    const file = makeFile(`const flat = _.flatten(arr)`)
    const findings = hallucinatedApiRule.check(file, lodashProject)
    expect(findings).toHaveLength(0)
  })

  it('skips a whitelisted method on any receiver, in the text check too', () => {
    const lodashProject = makeProject({ detectedFrameworks: new Set(['lodash']) })
    for (const withAst of [true, false]) {
      expect(hallucinatedApiRule.check(makeFile(`const flat = list.flatten()`, { withAst }), lodashProject)).toHaveLength(0)
    }
  })

  it('still flags .substr() even with Prisma', () => {
    const prismaProject = makeProject({ detectedFrameworks: new Set(['prisma']) })
    const file = makeFile(`const sub = str.substr(0, 5)`)
    const findings = hallucinatedApiRule.check(file, prismaProject)
    expect(findings).toHaveLength(1)
  })

  it('still flags .contains() without any framework', () => {
    const file = makeFile(`if (arr.contains(x)) {}`)
    const findings = hallucinatedApiRule.check(file, project)
    expect(findings).toHaveLength(1)
  })

  // DOMTokenList and Node have .contains() and no .includes(), so the old hint broke them
  it('does not flag DOM classList.contains()', () => {
    const file = makeFile(`if (el.classList.contains('open')) close()`)
    const findings = hallucinatedApiRule.check(file, project)
    expect(findings).toHaveLength(0)
  })

  it('does not flag Node.contains() on refs, the document or event targets', () => {
    const file = makeFile([
      'if (ref.current && !ref.current.contains(event.target as Node)) setOpen(false)',
      'if (menuRef.current?.contains(e.target)) return',
      'const attached = document.body.contains(node)',
      'if (!panel.contains(document.activeElement)) blur()',
    ].join('\n'))
    const findings = hallucinatedApiRule.check(file, project)
    expect(findings).toHaveLength(0)
  })

  it('says .includes() is for arrays and strings, so DOM code is left alone', () => {
    const file = makeFile(`if (tags.contains('a')) {}`)
    const findings = hallucinatedApiRule.check(file, project)
    expect(findings).toHaveLength(1)
    expect(findings[0].fix).toMatch(/arrays and strings/)
    expect(findings[0].fix).toMatch(/classList/)
  })

  // What the rule is for: an array or a string given a method it doesn't have
  describe('keeps reporting an array or a string given .contains() or .flatten()', () => {
    it('reports a receiver nothing is known about', () => {
      const code = [
        'export function has(items, x) { return items.contains(x) }',
        "export const isAdmin = (user) => user.name.contains('admin')",
        'export const flat = (list) => list.flatten()',
      ].join('\n')
      expect(reported(code)).toEqual(at(code, 'items.contains(', 'name.contains(', 'list.flatten('))
    })

    it('reports what the file shows is an array or a string', () => {
      const code = [
        "const tags: string[] = ['a']",
        "if (tags.contains('a')) {}",
        "const name = 'Ada'",
        "if (name.contains('A')) {}",
        "if (['a', 'b'].contains(x)) {}",
        "if (str.toLowerCase().contains('x')) {}",
        "if (input.toString().trim().contains('x')) {}",
        'if (Object.keys(map).contains(key)) {}',
        'const nested = [[1], [2]].flatten()',
        'const deeper = rows.map(r => r.cells).flatten(2)',
      ].join('\n')
      expect(reported(code)).toEqual(at(code, 'tags.contains(', 'name.contains(', "'b'].contains(", 'toLowerCase().contains(',
        'trim().contains(', '(map).contains(', '[2]].flatten(', 'cells).flatten('))
    })

    it('reads a declared type, a type alias, a cast, state, a class field and rest parameters', () => {
      const code = [
        'type Tags = readonly string[]',
        'function a(tags: Tags) { return tags.contains("x") }',
        'function b(words: Array<string> | null) { return words!.contains("x") }',
        'const c = (value as string).contains("x")',
        'function D() { const [items] = useState<number[]>([]); return items.contains(1) }',
        'class E { ids: string[] = []; has(id) { return this.ids.contains(id) } }',
        'function f(...args) { return args.contains("--help") }',
      ].join('\n')
      expect(reported(code)).toEqual(at(code, 'tags.contains(', 'words!.contains(', 'string).contains(', 'items.contains(',
        'ids.contains(', 'args.contains('))
    })

    it('reports an array of elements asked for one: the file shows an array, whatever is passed', () => {
      const code = 'const open: HTMLElement[] = []\nif (open.contains(e.target as HTMLElement)) close()'
      expect(reported(code)).toEqual(at(code, 'open.contains('))
    })

    it("reports a known string or array whatever it's handed, though the shape fits another API", () => {
      const code = [
        'const str = "To be, or not to be"',
        'console.log(str.contains("To be", 1))',
        "if (['a'].contains(/a/)) {}",
        'const rows = [[1], [2]]',
        'const flat = rows.flatten((row) => row)',
      ].join('\n')
      expect(reported(code)).toEqual(at(code, 'str.contains(', "'a'].contains(", 'rows.flatten('))
    })

    // Each of these has two arguments, which alone would read as another API's: only knowing
    // the receiver is an array or a string keeps it reported
    it('knows an array or a string by each way the file shows one', () => {
      const code = [
        "if (name.toLowerCase().contains('a', 1)) {}",
        'if (Object.keys(map).contains(key, 1)) {}',
        "if (String(value).contains('a', 1)) {}",
        'if ([1, 2].map(n => n * 2).contains(2, 0)) {}',
        "const list = ready && ['a', 'b']",
        "if (list.contains('a', 1)) {}",
        'function f(...args) { return args.contains("--help", 1) }',
        'function G() { const [items] = useState<string[]>(); return items.contains("a", 1) }',
        'function h(x: string | HTMLElement) { return x.contains("a", 1) }',
        'class Q { constructor() { this.ids = [] } has(id) { return this.ids.contains(id, 1) } }',
        'function k() { if (ready) { var names = ["a"] } return names.contains("a", 1) }',
      ].join('\n')
      expect(reported(code)).toEqual(at(code, 'toLowerCase().contains(', '(map).contains(', '(value).contains(', '* 2).contains(',
        'list.contains(', 'args.contains(', 'items.contains(', 'x.contains("a", 1)', 'ids.contains(', 'names.contains('))
    })

    it("doesn't take a type parameter for a class", () => {
      const code = 'export function first<T>(items: T, x) { return items.contains(x) }'
      expect(reported(code)).toEqual(at(code, 'items.contains('))
    })

    it('reports one finding a line for each method, at the first call', () => {
      const code = 'if (a.contains(x) || b.contains(y)) {}'
      expect(reported(code)).toEqual(at(code, 'a.contains('))
    })

    it('reports a second call on a line whose first is real, which the text check never looked at', () => {
      const code = "if (el.classList.contains('open') && label.contains('x')) {}"
      expect(reported(code)).toEqual(at(code, 'label.contains('))
    })

    it('reports text asked of a name an element might have', () => {
      const code = "if (el.contains('open')) {}\nif (menuEl.contains('open')) {}"
      expect(reported(code)).toEqual(at(code, 'el.contains(', 'menuEl.contains('))
    })
  })

  // 1. `...flatten(x)` calls a function named flatten: the last dot of the spread isn't a member access
  describe('a spread call', () => {
    it('is not a method call', () => {
      expect(reported([
        'export function flatten(links) { return links }',
        'const flattenedLinks = [null, ...flatten(nav), null]',
        'const all = { ...contains(x) }',
      ].join('\n'))).toEqual([])
    })

    it('is not a method call in the text check either', () => {
      expect(reported('const flattenedLinks = [null, ...flatten(nav), null]', { withAst: false })).toEqual([])
      expect(reported('const everything = [...flatten()]', { withAst: false })).toEqual([])
      const code = 'const flat = list.flatten()'
      expect(reported(code, { withAst: false })).toEqual(at(code, 'list.flatten('))
    })
  })

  // 2. A schema validation error's own flatten(): zod's `error.flatten()`
  describe('a schema validation error', () => {
    const code = [
      'const parsed = schema.safeParse(body)',
      'if (!parsed.success) return Response.json({ message: parsed.error.flatten() })',
      'const { fieldErrors } = result.error?.flatten() ?? {}',
      'const formatted = { zodError: error.cause instanceof ZodError ? error.cause.flatten() : null }',
      'try { run() } catch (e) { report(e.flatten()) }',
      'const errs = (thrown as z.ZodError).flatten()',
      'const fields = validation.flatten().fieldErrors',
    ].join('\n')

    it("is left alone on an error, its cause, a caught error, a cast, or with what zod's flatten() returns", () => {
      expect(reported(code)).toEqual([])
    })

    it('is left alone in the text check too, but for a caught error the line says nothing about', () => {
      expect(reported(code, { withAst: false })).toEqual(at(code, 'report(e.flatten('))
    })
  })

  // 3. A test runner's .contains(): Cypress's and chai's
  describe("a test runner's chain", () => {
    it("is left alone on cy, expect() and a Cypress spec's page helpers", () => {
      expect(reported([
        "import { getGreeting } from '../support/app.po'",
        "cy.get('h1').contains('About Page')",
        "cy.contains('Login').click()",
        "cy.get('form').contains('label', 'Password')",
        "getGreeting().contains('Welcome')",
        'expect(list).to.contains(item)',
        "await t.expect(Selector('body').textContent).contains('Welcome')",
      ].join('\n'), { relativePath: 'cypress/e2e/app.cy.ts' })).toEqual([])
    })

    it("doesn't take an imported helper's result for Cypress's outside a Cypress spec", () => {
      const code = "import { getTitle } from './titles'\nif (getTitle().contains('x')) {}"
      expect(reported(code)).toEqual(at(code, ').contains('))
    })

    it("doesn't take a local cy for Cypress", () => {
      const code = "export const check = (cy) => cy.contains('a')"
      expect(reported(code)).toEqual(at(code, 'cy.contains('))
    })

    it('is left alone in the text check too', () => {
      expect(reported("cy.get('h1').contains('About')", { withAst: false })).toEqual([])
    })
  })

  // 4. A DOM node's .contains(node), on receivers no name list covers
  describe('a DOM node', () => {
    it('is left alone when an event, a ref or a DOM call gives it', () => {
      expect(reported([
        'document.addEventListener("click", (e) => { if (e.target.contains(main)) close() })',
        'const outside = !e.currentTarget.contains(e.relatedTarget)',
        'const sheet = document.querySelector(".sheet")',
        'if (sheet.contains(active)) {}',
        'const found = Array.from(document.querySelectorAll("[data-x]")).find((el) => el.contains(target))',
        'if (rootElement.contains(selection.anchorNode)) {}',
        'const inside = outerNode.contains(innerNode)',
        'if (!wrapperRef.current?.contains(event.target)) setOpen(false)',
        'if (this.$el.contains(node)) {}',
      ].join('\n'))).toEqual([])
    })

    it('is left alone when its type says so', () => {
      expect(reported([
        'function inSheet(sheetContent: HTMLElement | null, active: Element | null) {',
        '  return sheetContent?.contains(active)',
        '}',
        'const isInside = (box: Node, el: Node) => box.contains(el)',
        'const current = e.currentTarget as HTMLElement | null',
        'if (current && current.contains(target)) {}',
      ].join('\n'))).toEqual([])
    })

    it('is left alone when both sides have names a node often has', () => {
      expect(reported('if (container.contains(target)) {}\nif (root.contains(el)) {}')).toEqual([])
    })

    it('is still reported when only the argument has such a name', () => {
      const code = 'export const seen = (visited, target) => visited.contains(target)'
      expect(reported(code)).toEqual(at(code, 'visited.contains('))
    })

    it('is left alone when the argument is a node by its value or its type', () => {
      expect(reported([
        'const target = event.target',
        'if (menu.contains(target)) {}',
        'export const has = (list, item: Node) => list.contains(item)',
      ].join('\n'))).toEqual([])
    })

    it("is still reported when a node's name is given to a string", () => {
      const code = "const el = 'x'\nif (container.contains(el)) {}"
      expect(reported(code)).toEqual(at(code, 'container.contains('))
    })

    it('is left alone when the file shows the receiver is one, whatever it is handed', () => {
      expect(reported("const box = document.querySelector('.box')\nif (box.contains('x')) {}")).toEqual([])
    })

    it('reads the nearest declaration of a name', () => {
      expect(reported([
        "const list = ['a']",
        'function inside(list: HTMLElement, node) { return list.contains(node) }',
      ].join('\n'))).toEqual([])
    })

    it('is left alone on token and string lists: classList, part, IndexedDB', () => {
      expect(reported([
        'const { classList } = event.target',
        'if (classList.contains("open")) {}',
        'const list = (e.target as HTMLDivElement).classList || []',
        'if (list.contains("site-layout")) {}',
        'if (img.part.contains("loading")) {}',
        'if (!db.objectStoreNames.contains("pending")) db.createObjectStore("pending")',
        'if (!store.indexNames.contains("by-date")) {}',
        'if (targetClassList.contains("active")) {}',
        'function getBodyClassList() { return document.body.classList }',
        'if (getBodyClassList().contains("navbar-open")) {}',
        'const clicked = e.target ? e.target.classList : []',
        'if (clicked.contains("dropdown-toggle")) {}',
        'if (event.target["classList"].contains("countryName")) {}',
      ].join('\n'))).toEqual([])
    })

    it('still reads `cond ? list : []` as an array when the list is one', () => {
      const code = "const names = cond ? ['a'] : []\nif (names.contains('a')) {}"
      expect(reported(code)).toEqual(at(code, 'names.contains('))
    })
  })

  // 5. A class's own .contains(): a filter, an interval, a set-like object
  describe("a class's own method", () => {
    it('is left alone on an instance, this and a typed field', () => {
      expect(reported([
        "import { BloomFilter } from './bloom-filter'",
        'const filter = new BloomFilter(10, 0.01)',
        "if (filter.contains('/about')) {}",
        'class Router {',
        '  private bloom?: BloomFilter',
        '  has(path: string) { return !!this.bloom?.contains(path) || this.contains(path) }',
        '}',
        'function visible(bounds: google.maps.LatLngBounds) { return bounds.contains(point) }',
      ].join('\n'))).toEqual([])
    })

    it('is left alone when nothing says what the receiver is and the file defines the method', () => {
      expect(reported([
        'export class Interval { contains(x: number) { return x >= this.lo && x <= this.hi } }',
        'export const covers = (interval, x) => interval.contains(x)',
        'export class Tree { flatten() { return [] } }',
        'export const all = (tree) => tree.flatten()',
      ].join('\n'))).toEqual([])
    })

    it("doesn't let a class of the file's own vouch for a value the file shows is an array or a string", () => {
      const code = [
        'export class Interval { contains(x: number) { return true } }',
        "const names = ['a']",
        "export const hasA = names.contains('a')",
      ].join('\n')
      expect(reported(code)).toEqual(at(code, 'names.contains('))
    })
  })

  describe('calls the file makes real', () => {
    it('leaves arrays and strings alone where the file gives them the method', () => {
      expect(reported([
        'Array.prototype.contains = function (x) { return this.indexOf(x) !== -1 }',
        "if (['a'].contains(x)) {}",
      ].join('\n'))).toEqual([])
      expect(reported([
        'String.implement({ contains: function (s) { return this.indexOf(s) > -1 } })',
        "if ('abc'.contains('a')) {}",
      ].join('\n'))).toEqual([])
      expect(reported([
        'declare global { interface Array<T> { flatten(): T[] } }',
        'const flat = [[1]].flatten()',
      ].join('\n'))).toEqual([])
    })

    it("doesn't take a key named contains for a method", () => {
      const code = "const where = { name: { contains: 'a' } }\nif (tags.contains('a')) {}"
      expect(reported(code)).toEqual(at(code, 'tags.contains('))
    })
  })

  describe('a call shaped like another API', () => {
    it("leaves alone .contains() with two arguments: a query builder's or a library's", () => {
      expect(reported([
        "const { data } = await supabase.from('posts').select('*').contains('tags', [tag])",
        'if (_.contains(list, x)) {}',
        'if (goog.string.contains(platform, "Mac")) {}',
        "if (source$.map(toKey).contains(key, 'strict')) {}",
      ].join('\n'))).toEqual([])
    })

    it('leaves alone .contains() handed what an array was never asked for: an object, an array, a regex, an element', () => {
      expect(reported([
        "if (await chrome.permissions.contains({ origins: ['<all_urls>'] })) {}",
        'if (!map.getBounds().contains([lat, lng])) map.panTo([lat, lng])',
        'header.contains(/Welcome/)',
        'expect(wrapper.contains(<div className="foo" />)).toBe(true)',
      ].join('\n'), { relativePath: 'test.tsx' })).toEqual([])
    })

    it('leaves alone .flatten() handed something: a function given what to flatten, or options', () => {
      expect(reported([
        'const style = StyleSheet.flatten([styles.base, props.style])',
        'const out = await sharp(input).flatten({ background: "#fff" }).toBuffer()',
        'const trimmed = await sharp(input).trim().flatten({ background: "#000" }).toBuffer()',
        'const all = _.flatten(groups)',
      ].join('\n'))).toEqual([])
    })

    it('leaves alone a lodash or underscore chain', () => {
      expect(reported([
        'const tags = _(posts).map("tags").flatten().uniq().value()',
        'const ids = _.chain(groups).map("ids").flatten().value()',
        'if (_(this.state.teams).map(_.keys).flatten().contains(name)) {}',
        'const codes = lodash(formats).map("countries").flatten().uniq().value()',
        'const values = lodash.chain(raw).flatten().uniq().value()',
        'const lines = _.chain(text).split("\\n").map(line => [line, "<br>"]).flatten().value()',
        'const all = _(groups).flatten().value()',
      ].join('\n'))).toEqual([])
    })

    it("reports .flatten() on what lodash's own map() returns: a plain array", () => {
      const code = 'const ids = _.map(groups, "ids").flatten()'
      expect(reported(code)).toEqual(at(code, ').flatten('))
    })

    it('leaves alone an optional call: the code allows for the method not being there', () => {
      expect(reported('if (list.contains?.(x)) {}\nconst flat = rows.flatten?.()')).toEqual([])
    })

    it('leaves alone a call the code checks for first, as minified React DOM does', () => {
      expect(reported([
        'function Le(a, b) { return "contains" in a ? a.contains(b) : false }',
        'const has = typeof this.set.contains === "function" && this.set.contains(item)',
        'if (rows.flatten) rows.flatten()',
        'if ("function" == typeof a.contains && ready) { a.contains(b) }',
      ].join('\n'))).toEqual([])
    })

    it("doesn't take a check of something else for one, or count it where the check failed", () => {
      const code = [
        'if ("contains" in other) { list.contains(x) }',
        'const r = list.flatten ? rows.flatten() : rows',
        'const s = "contains" in a ? false : a.contains(b)',
      ].join('\n')
      expect(reported(code)).toEqual(at(code, 'list.contains(', 'rows.flatten(', 'a.contains('))
    })
  })

  describe('the other APIs', () => {
    it('reports calls, not text in strings, comments or regexes', () => {
      const code = [
        "const hint = 'use str.substr(0, 1) or arr.contains(x)'",
        '// list.flatten() is not a method',
        'const re = /\\.trimLeft\\s*\\(/',
        'const a = s.substr(1)',
        'const b = s.trimLeft()',
        'const c = s.trimRight()',
      ].join('\n')
      expect(reported(code)).toEqual(at(code, 's.substr(', 's.trimLeft(', 's.trimRight('))
    })

    it('reports fetch.abort(), a bare .isArray() and .hasOwnProperty(), as before', () => {
      const code = [
        'fetch.abort()',
        'if (value.isArray()) {}',
        'if (obj.hasOwnProperty(key)) {}',
      ].join('\n')
      expect(reported(code)).toEqual(at(code, 'fetch.abort(', 'value.isArray(', 'obj.hasOwnProperty('))
    })

    it('leaves alone what only looks like them', () => {
      expect(reported([
        'controller.abort()',
        'if (Array.isArray(value)) {}',
        'if (Object.prototype.hasOwnProperty.call(obj, key)) {}',
        'const own = Object.prototype.hasOwnProperty(key)',
        'const data = await res.json()',
        'const text = await response.text()',
      ].join('\n'))).toEqual([])
    })
  })

  it('falls back to the text check for a file Babel cannot parse', () => {
    const code = 'const flat = list.flatten()\nif (arr.contains(x)) {'
    expect(reported(code, { relativePath: 'broken.ts' })).toEqual(at(code, 'list.flatten(', 'arr.contains('))
  })
})
