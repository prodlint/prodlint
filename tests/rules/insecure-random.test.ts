import { describe, it, expect } from 'vitest'
import { insecureRandomRule } from '../../src/rules/insecure-random.js'
import { makeFile, makeProject } from '../helpers.js'

const project = makeProject()

describe('insecure-random rule', () => {
  it('flags Math.random() assigned to token variable', () => {
    const file = makeFile(`const token = Math.random().toString(36)`, { relativePath: 'src/auth.ts' })
    const findings = insecureRandomRule.check(file, project)
    expect(findings).toHaveLength(1)
    expect(findings[0].message).toContain('Math.random')
  })

  it('flags Math.random() near security variable 2 lines above', () => {
    const file = makeFile([
      'const sessionId = ""',
      'const prefix = "sess_"',
      'const rand = Math.random().toString(36)',
    ].join('\n'), { relativePath: 'src/session.ts' })
    const findings = insecureRandomRule.check(file, project)
    expect(findings).toHaveLength(1)
  })

  it('allows Math.random() in non-security context', () => {
    const file = makeFile(`const color = Math.random() > 0.5 ? 'red' : 'blue'`, { relativePath: 'src/ui.ts' })
    const findings = insecureRandomRule.check(file, project)
    expect(findings).toHaveLength(0)
  })

  it('skips test files', () => {
    const file = makeFile(`const token = Math.random().toString(36)`, { relativePath: 'tests/gen.test.ts' })
    const findings = insecureRandomRule.check(file, project)
    expect(findings).toHaveLength(0)
  })

  it('includes fix suggestion', () => {
    const file = makeFile(`const secret = Math.random().toString(36)`, { relativePath: 'src/auth.ts' })
    const findings = insecureRandomRule.check(file, project)
    expect(findings[0].fix).toContain('crypto')
  })

  it('flags Math.random() with password context', () => {
    const file = makeFile(`const password = Math.random().toString(36).slice(2)`, { relativePath: 'src/users.ts' })
    const findings = insecureRandomRule.check(file, project)
    expect(findings).toHaveLength(1)
  })

  it('flags Math.random() with otp context', () => {
    const file = makeFile(`const otp = Math.floor(Math.random() * 999999)`, { relativePath: 'src/verify.ts' })
    const findings = insecureRandomRule.check(file, project)
    expect(findings).toHaveLength(1)
  })
})
