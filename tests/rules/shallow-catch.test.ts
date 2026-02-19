import { describe, it, expect } from 'vitest'
import { shallowCatchRule } from '../../src/rules/shallow-catch.js'
import { makeFile, makeProject } from '../helpers.js'

const project = makeProject()

describe('shallow-catch rule', () => {
  it('flags empty catch block', () => {
    const file = makeFile(`try {\n  doStuff()\n} catch (e) {\n}`)
    const findings = shallowCatchRule.check(file, project)
    expect(findings).toHaveLength(1)
    expect(findings[0].message).toContain('Empty catch')
    expect(findings[0].severity).toBe('warning')
  })

  it('flags single-line empty catch', () => {
    const file = makeFile(`try { doStuff() } catch (e) {}`)
    const findings = shallowCatchRule.check(file, project)
    expect(findings).toHaveLength(1)
    expect(findings[0].message).toContain('Empty catch')
  })

  it('flags catch with only console.log', () => {
    const file = makeFile(`try {\n  doStuff()\n} catch (e) {\n  console.log("error")\n}`)
    const findings = shallowCatchRule.check(file, project)
    expect(findings).toHaveLength(1)
    expect(findings[0].message).toContain('Decorative')
  })

  it('allows catch that re-throws', () => {
    const file = makeFile(`try {\n  doStuff()\n} catch (e) {\n  throw new Error("wrapped", { cause: e })\n}`)
    const findings = shallowCatchRule.check(file, project)
    expect(findings).toHaveLength(0)
  })

  it('allows catch that returns error response', () => {
    const file = makeFile(`try {\n  doStuff()\n} catch (e) {\n  return NextResponse.json({ error: e.message }, { status: 500 })\n}`)
    const findings = shallowCatchRule.check(file, project)
    expect(findings).toHaveLength(0)
  })

  it('allows catch with console.error and error object', () => {
    const file = makeFile(`try {\n  doStuff()\n} catch (error) {\n  console.error("Failed:", error)\n}`)
    const findings = shallowCatchRule.check(file, project)
    expect(findings).toHaveLength(0)
  })

  it('allows catch that sets error state', () => {
    const file = makeFile(`try {\n  doStuff()\n} catch (e) {\n  setError(e.message)\n}`)
    const findings = shallowCatchRule.check(file, project)
    expect(findings).toHaveLength(0)
  })

  it('allows catch that uses res.status', () => {
    const file = makeFile(`try {\n  doStuff()\n} catch (e) {\n  res.status(500).json({ error: e })\n}`)
    const findings = shallowCatchRule.check(file, project)
    expect(findings).toHaveLength(0)
  })

  it('flags multiple shallow catches in same file', () => {
    const file = makeFile([
      'try { a() } catch (e) {}',
      'try { b() } catch (e) {}',
    ].join('\n'))
    const findings = shallowCatchRule.check(file, project)
    expect(findings).toHaveLength(2)
  })

  it('skips test files', () => {
    const file = makeFile(`try { x() } catch (e) {}`, { relativePath: 'tests/foo.test.ts' })
    const findings = shallowCatchRule.check(file, project)
    expect(findings).toHaveLength(0)
  })

  it('skips script files', () => {
    const file = makeFile(`try { x() } catch (e) {}`, { relativePath: 'scripts/seed.ts' })
    const findings = shallowCatchRule.check(file, project)
    expect(findings).toHaveLength(0)
  })

  it('returns empty for clean code', () => {
    const file = makeFile(`export function add(a: number, b: number) { return a + b }`)
    const findings = shallowCatchRule.check(file, project)
    expect(findings).toHaveLength(0)
  })

  it('handles braces inside template literals in catch body', () => {
    const file = makeFile([
      'try {',
      '  doStuff()',
      '} catch (e) {',
      '  throw new Error(`Failed: ${"}"}`)',
      '}',
    ].join('\n'))
    const findings = shallowCatchRule.check(file, project)
    // re-throw should score 3, not flag
    expect(findings).toHaveLength(0)
  })

  it('handles braces inside string literals in catch body', () => {
    const file = makeFile([
      'try {',
      '  doStuff()',
      '} catch (e) {',
      '  throw new Error("closing } brace")',
      '}',
    ].join('\n'))
    const findings = shallowCatchRule.check(file, project)
    expect(findings).toHaveLength(0)
  })

  // AST improvement: handles } inside template literal expression
  it('AST: handles } inside template literal expression in catch body', () => {
    const file = makeFile([
      'try {',
      '  doStuff()',
      '} catch (e) {',
      '  throw new Error(`Failed with ${JSON.stringify({ key: "}" })}`)',
      '}',
    ].join('\n'))
    const findings = shallowCatchRule.check(file, project)
    expect(findings).toHaveLength(0)
  })

  // AST improvement: regex fallback still works
  it('falls back to regex when AST is unavailable', () => {
    const file = makeFile(`try { doStuff() } catch (e) {}`, { withAst: false })
    const findings = shallowCatchRule.check(file, project)
    expect(findings).toHaveLength(1)
    expect(findings[0].message).toContain('Empty catch')
  })
})
