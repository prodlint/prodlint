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

  it('detects Anthropic API key', () => {
    const file = makeFile(`const key = "sk-ant-api03-AbCdEf1234567890GhIjKlMnOpQrStUvWxYz_-1234567890aBcDeFgHiJkLmNoPqRsTuVwXyZ09"`)
    const findings = secretsRule.check(file, project)
    expect(findings).toHaveLength(1)
    expect(findings[0].message).toContain('Anthropic API key')
  })

  it('detects Anthropic admin key', () => {
    const file = makeFile(`const key = "sk-ant-admin01-AbCdEf1234567890GhIjKlMnOpQrStUvWxYz_-1234567890aBcDeFgHiJkLmNoPqRsT"`)
    const findings = secretsRule.check(file, project)
    expect(findings).toHaveLength(1)
    expect(findings[0].message).toContain('Anthropic API key')
  })

  it('ignores non-key sk-ant- prefixes', () => {
    const file = makeFile(`const slug = "sk-ant-short"`)
    const findings = secretsRule.check(file, project)
    expect(findings).toHaveLength(0)
  })

  it('detects Google API key', () => {
    const file = makeFile(`const k = "AIzaSyD0123456789abcdefghijklmnopqrstuvwxyz"`)
    const findings = secretsRule.check(file, project)
    expect(findings.some(f => f.message.includes('Google API key'))).toBe(true)
  })

  it('detects Google OAuth client secret', () => {
    const file = makeFile(`const s = "GOCSPX-1234567890abcdefghijklmnop"`)
    const findings = secretsRule.check(file, project)
    expect(findings[0].message).toContain('Google OAuth client secret')
  })

  it('detects GitLab personal access token', () => {
    const file = makeFile(`const t = "glpat-1234567890abcdefghijkl"`)
    const findings = secretsRule.check(file, project)
    expect(findings[0].message).toContain('GitLab personal access token')
  })

  it('detects npm access token', () => {
    const file = makeFile(`const t = "npm_0123456789abcdefghijklmnopqrstuvwxyz"`)
    const findings = secretsRule.check(file, project)
    expect(findings[0].message).toContain('npm access token')
  })

  it('detects Slack token', () => {
    const file = makeFile(`const t = "xoxb-1234567890-1234567890-abcdefghij"`)
    const findings = secretsRule.check(file, project)
    expect(findings[0].message).toContain('Slack token')
  })

  it('detects Slack webhook URL', () => {
    const file = makeFile(`const u = "https://hooks.slack.com/services/EXAMPLE_FAKE_WEBHOOK_PATH_1234567890"`)
    const findings = secretsRule.check(file, project)
    expect(findings.some(f => f.message.includes('Slack webhook URL'))).toBe(true)
  })

  it('detects Supabase secret key', () => {
    const file = makeFile(`const k = "sb_secret_1234567890abcdefghijkl"`)
    const findings = secretsRule.check(file, project)
    expect(findings[0].message).toContain('Supabase secret key')
  })

  it('detects Hugging Face token', () => {
    const file = makeFile(`const t = "hf_0123456789abcdefghijklmnopqrstuvwx"`)
    const findings = secretsRule.check(file, project)
    expect(findings[0].message).toContain('Hugging Face token')
  })

  it('detects Groq API key', () => {
    const file = makeFile(`const k = "gsk_0123456789abcdefghijklmnopqrstuvwxyz0123456789ABCD"`)
    const findings = secretsRule.check(file, project)
    expect(findings[0].message).toContain('Groq API key')
  })

  it('detects PEM private key block', () => {
    const file = makeFile(`const pem = \`-----BEGIN RSA PRIVATE KEY-----\``)
    const findings = secretsRule.check(file, project)
    expect(findings[0].message).toContain('private key')
  })

  it('detects database connection string with credentials', () => {
    const file = makeFile(`const url = "postgres://admin:s3cr3tP4ss@db.example.com:5432/app"`)
    const findings = secretsRule.check(file, project)
    expect(findings[0].message).toContain('database connection string')
  })

  it('ignores DB URL without credentials', () => {
    const file = makeFile(`const url = "postgres://localhost:5432/app"`)
    const findings = secretsRule.check(file, project)
    expect(findings).toHaveLength(0)
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

  it('detects short Stripe keys (8+ chars after prefix)', () => {
    const file = makeFile(`const key = "sk_live_abc123def456"`)
    const findings = secretsRule.check(file, project)
    expect(findings).toHaveLength(1)
    expect(findings[0].message).toContain('Stripe secret key')
  })

  it('ignores too-short Stripe prefix (under 8 chars)', () => {
    const file = makeFile(`const key = "sk_live_short"`)
    const findings = secretsRule.check(file, project)
    expect(findings).toHaveLength(0)
  })

  it('returns no findings for clean code', () => {
    const file = makeFile(`export function hello() { return "world" }`)
    const findings = secretsRule.check(file, project)
    expect(findings).toHaveLength(0)
  })
})
