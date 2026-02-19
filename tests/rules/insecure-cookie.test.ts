import { describe, it, expect } from 'vitest'
import { insecureCookieRule } from '../../src/rules/insecure-cookie.js'
import { makeFile, makeProject } from '../helpers.js'

const project = makeProject()

describe('insecure-cookie rule', () => {
  it('flags cookies().set with sensitive name missing all options', () => {
    const file = makeFile(`cookies().set('session', value)`, { relativePath: 'src/auth.ts' })
    const findings = insecureCookieRule.check(file, project)
    expect(findings).toHaveLength(1)
    expect(findings[0].message).toContain('httpOnly')
  })

  it('flags res.cookie with token name missing options', () => {
    const file = makeFile(`res.cookie('token', jwt)`, { relativePath: 'src/auth.ts' })
    const findings = insecureCookieRule.check(file, project)
    expect(findings).toHaveLength(1)
  })

  it('allows cookie with all secure options', () => {
    const file = makeFile([
      `cookies().set('session', value, {`,
      `  httpOnly: true,`,
      `  secure: true,`,
      `  sameSite: 'lax',`,
      `})`,
    ].join('\n'), { relativePath: 'src/auth.ts' })
    const findings = insecureCookieRule.check(file, project)
    expect(findings).toHaveLength(0)
  })

  it('ignores non-sensitive cookie names', () => {
    const file = makeFile(`cookies().set('theme', 'dark')`, { relativePath: 'src/prefs.ts' })
    const findings = insecureCookieRule.check(file, project)
    expect(findings).toHaveLength(0)
  })

  it('skips test files', () => {
    const file = makeFile(`cookies().set('session', value)`, { relativePath: 'tests/auth.test.ts' })
    const findings = insecureCookieRule.check(file, project)
    expect(findings).toHaveLength(0)
  })

  it('includes fix suggestion', () => {
    const file = makeFile(`cookies().set('auth', token)`, { relativePath: 'src/auth.ts' })
    const findings = insecureCookieRule.check(file, project)
    expect(findings[0].fix).toContain('httpOnly')
  })

  it('flags response.cookies.set', () => {
    const file = makeFile(`response.cookies.set('jwt', token)`, { relativePath: 'src/auth.ts' })
    const findings = insecureCookieRule.check(file, project)
    expect(findings).toHaveLength(1)
  })

  it('flags when only some options are missing', () => {
    const file = makeFile([
      `cookies().set('session', value, {`,
      `  httpOnly: true,`,
      `})`,
    ].join('\n'), { relativePath: 'src/auth.ts' })
    const findings = insecureCookieRule.check(file, project)
    expect(findings).toHaveLength(1)
    expect(findings[0].message).toContain('secure')
  })
})
