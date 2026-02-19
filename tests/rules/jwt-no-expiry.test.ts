import { describe, it, expect } from 'vitest'
import { jwtNoExpiryRule } from '../../src/rules/jwt-no-expiry.js'
import { makeFile, makeProject } from '../helpers.js'

const project = makeProject()

describe('jwt-no-expiry rule', () => {
  it('detects jwt.sign without expiresIn', () => {
    const file = makeFile(`const token = jwt.sign({ userId: user.id }, secret)`)
    const findings = jwtNoExpiryRule.check(file, project)
    expect(findings).toHaveLength(1)
    expect(findings[0].ruleId).toBe('jwt-no-expiry')
  })

  it('allows jwt.sign with expiresIn', () => {
    const file = makeFile(`const token = jwt.sign({ userId: user.id }, secret, { expiresIn: '1h' })`)
    const findings = jwtNoExpiryRule.check(file, project)
    expect(findings).toHaveLength(0)
  })

  it('allows jwt.sign with exp in payload', () => {
    const file = makeFile(`const token = jwt.sign({ userId: user.id, exp: Math.floor(Date.now() / 1000) + 3600 }, secret)`)
    const findings = jwtNoExpiryRule.check(file, project)
    expect(findings).toHaveLength(0)
  })

  it('allows jwt.sign with multiline expiresIn', () => {
    const file = makeFile(`const token = jwt.sign(
  { userId: user.id },
  secret,
  { expiresIn: '24h' }
)`)
    const findings = jwtNoExpiryRule.check(file, project)
    expect(findings).toHaveLength(0)
  })

  it('ignores files without jwt', () => {
    const file = makeFile(`const token = generateToken(user)`)
    const findings = jwtNoExpiryRule.check(file, project)
    expect(findings).toHaveLength(0)
  })

  it('skips test files', () => {
    const file = makeFile(`jwt.sign({ id: 1 }, 'test')`, { relativePath: 'tests/auth.test.ts' })
    const findings = jwtNoExpiryRule.check(file, project)
    expect(findings).toHaveLength(0)
  })
})
