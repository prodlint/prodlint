import { describe, it, expect } from 'vitest'
import { redirectInTryCatchRule } from '../../src/rules/redirect-in-try-catch.js'
import { makeFile, makeProject } from '../helpers.js'

const project = makeProject()

describe('redirect-in-try-catch rule', () => {
  it('detects redirect inside try block', () => {
    const file = makeFile(`
try {
  await db.insert(data)
  redirect('/dashboard')
} catch (e) {
  console.error(e)
}`)
    const findings = redirectInTryCatchRule.check(file, project)
    expect(findings.length).toBeGreaterThan(0)
    expect(findings[0].ruleId).toBe('redirect-in-try-catch')
    expect(findings[0].severity).toBe('critical')
  })

  it('allows redirect outside try/catch', () => {
    const file = makeFile(`
await db.insert(data)
redirect('/dashboard')
`)
    const findings = redirectInTryCatchRule.check(file, project)
    expect(findings).toHaveLength(0)
  })

  it('ignores redirect in comments', () => {
    const file = makeFile(`
try {
  // redirect('/dashboard')
} catch (e) {}
`)
    const findings = redirectInTryCatchRule.check(file, project)
    expect(findings).toHaveLength(0)
  })

  it('skips test files', () => {
    const file = makeFile(`
try {
  redirect('/dashboard')
} catch (e) {}
`, { relativePath: 'tests/test.ts' })
    const findings = redirectInTryCatchRule.check(file, project)
    expect(findings).toHaveLength(0)
  })

  it('provides a fix suggestion', () => {
    const file = makeFile(`
try {
  redirect('/dashboard')
} catch (e) {}
`)
    const findings = redirectInTryCatchRule.check(file, project)
    expect(findings[0].fix).toBeTruthy()
  })
})
