import { describe, it, expect } from 'vitest'
import { secretsRule } from '../../src/rules/secrets.js'
import { makeFile, makeProject } from '../helpers.js'

const project = makeProject()

describe('secrets rule', () => {
  it('detects Stripe live key', () => {
    const file = makeFile(`const key = "sk_live_abcdefghijklmnopqrstuv"`)
    const findings = secretsRule.check(file, project)
    expect(findings).toHaveLength(1)
    expect(findings[0].message).toContain('Stripe secret key')
  })

  it('detects Stripe test key', () => {
    const file = makeFile(`const key = "sk_test_abcdefghijklmnopqrstuv"`)
    const findings = secretsRule.check(file, project)
    expect(findings).toHaveLength(1)
    expect(findings[0].message).toContain('Stripe test key')
  })

  it('detects AWS access key', () => {
    const file = makeFile(`const id = "AKIAIOSFODNN7EXAMPLE"`)
    const findings = secretsRule.check(file, project)
    expect(findings).toHaveLength(1)
    expect(findings[0].message).toContain('AWS access key')
  })

  it('detects GitHub PAT', () => {
    const file = makeFile(`const token = "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij"`)
    const findings = secretsRule.check(file, project)
    expect(findings).toHaveLength(1)
    expect(findings[0].message).toContain('GitHub token')
  })

  it('detects generic API key assignment', () => {
    const file = makeFile(`const api_key = "abc123def456ghi789jkl012mno"`)
    const findings = secretsRule.check(file, project)
    expect(findings).toHaveLength(1)
    expect(findings[0].message).toContain('Generic API key')
  })

  it('ignores env var references', () => {
    const file = makeFile(`const key = process.env.STRIPE_SECRET_KEY`)
    const findings = secretsRule.check(file, project)
    expect(findings).toHaveLength(0)
  })

  it('ignores keys in comments', () => {
    const file = makeFile(`// const key = "sk_live_abcdefghijklmnopqrstuv"`)
    const findings = secretsRule.check(file, project)
    expect(findings).toHaveLength(0)
  })

  it('ignores keys in block comments', () => {
    const file = makeFile(`/*\nsk_live_abcdefghijklmnopqrstuv\n*/`)
    const findings = secretsRule.check(file, project)
    expect(findings).toHaveLength(0)
  })

  it('reports correct line and column', () => {
    const file = makeFile(`const x = 1\nconst key = "sk_live_abcdefghijklmnopqrstuv"`)
    const findings = secretsRule.check(file, project)
    expect(findings[0].line).toBe(2)
    expect(findings[0].column).toBeGreaterThan(0)
  })

  it('returns no findings for clean code', () => {
    const file = makeFile(`export function hello() { return "world" }`)
    const findings = secretsRule.check(file, project)
    expect(findings).toHaveLength(0)
  })
})
