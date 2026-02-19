import { describe, it, expect } from 'vitest'
import { clientSideAuthOnlyRule } from '../../src/rules/client-side-auth-only.js'
import { makeFile, makeProject } from '../helpers.js'

const project = makeProject()

describe('client-side-auth-only rule', () => {
  it('detects password comparison in client code', () => {
    const file = makeFile(`'use client'
function login(input) {
  if (password === "admin123") {
    setLoggedIn(true)
  }
}`, { relativePath: 'components/login.tsx' })
    const findings = clientSideAuthOnlyRule.check(file, project)
    expect(findings.length).toBeGreaterThan(0)
    expect(findings[0].severity).toBe('critical')
  })

  it('detects auth token in localStorage', () => {
    const file = makeFile(`'use client'
function login() {
  localStorage.setItem('token', response.token)
}`, { relativePath: 'components/auth.tsx' })
    const findings = clientSideAuthOnlyRule.check(file, project)
    expect(findings.length).toBeGreaterThan(0)
    expect(findings[0].message).toContain('localStorage')
  })

  it('detects session in localStorage', () => {
    const file = makeFile(`'use client'
const session = localStorage.getItem('session')`, { relativePath: 'components/guard.tsx' })
    const findings = clientSideAuthOnlyRule.check(file, project)
    expect(findings.length).toBeGreaterThan(0)
  })

  it('ignores server components', () => {
    const file = makeFile(`
function login() {
  localStorage.setItem('token', response.token)
}`, { relativePath: 'components/auth.tsx' })
    const findings = clientSideAuthOnlyRule.check(file, project)
    expect(findings).toHaveLength(0)
  })

  it('skips test files', () => {
    const file = makeFile(`'use client'
localStorage.setItem('token', 'test')`, { relativePath: 'tests/auth.test.ts' })
    const findings = clientSideAuthOnlyRule.check(file, project)
    expect(findings).toHaveLength(0)
  })
})
