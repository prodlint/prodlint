import { describe, it, expect } from 'vitest'
import { nextPublicSensitiveRule } from '../../src/rules/next-public-sensitive.js'
import { makeFile, makeProject, scanFiles } from '../helpers.js'

const project = makeProject()

describe('next-public-sensitive rule', () => {
  it('detects NEXT_PUBLIC_ with SECRET', () => {
    const file = makeFile(`const key = process.env.NEXT_PUBLIC_SECRET_KEY`)
    const findings = nextPublicSensitiveRule.check(file, project)
    expect(findings).toHaveLength(1)
    expect(findings[0].severity).toBe('critical')
  })

  it('detects NEXT_PUBLIC_ with DATABASE_URL', () => {
    const file = makeFile(`const url = process.env.NEXT_PUBLIC_DATABASE_URL`)
    const findings = nextPublicSensitiveRule.check(file, project)
    expect(findings).toHaveLength(1)
  })

  it('detects NEXT_PUBLIC_ with SERVICE_ROLE', () => {
    const file = makeFile(`const key = process.env.NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY`)
    const findings = nextPublicSensitiveRule.check(file, project)
    expect(findings).toHaveLength(1)
  })

  it('detects NEXT_PUBLIC_ with sk_live', () => {
    const file = makeFile(`const key = "NEXT_PUBLIC_sk_live_test123"`)
    const findings = nextPublicSensitiveRule.check(file, project)
    expect(findings).toHaveLength(1)
  })

  it('allows NEXT_PUBLIC_ on non-sensitive vars', () => {
    const file = makeFile(`const url = process.env.NEXT_PUBLIC_API_URL`)
    const findings = nextPublicSensitiveRule.check(file, project)
    expect(findings).toHaveLength(0)
  })

  it('allows NEXT_PUBLIC_ with SUPABASE_URL', () => {
    const file = makeFile(`const url = process.env.NEXT_PUBLIC_SUPABASE_URL`)
    const findings = nextPublicSensitiveRule.check(file, project)
    expect(findings).toHaveLength(0)
  })

  it('skips test files', () => {
    const file = makeFile(`const key = process.env.NEXT_PUBLIC_SECRET_KEY`, { relativePath: 'tests/env.test.ts' })
    const findings = nextPublicSensitiveRule.check(file, project)
    expect(findings).toHaveLength(0)
  })

  // Through the scanner: .env files used to get an extension no rule listed, so none were read
  it('checks .env files', async () => {
    const result = await scanFiles({
      '.env': 'NEXT_PUBLIC_SITE_URL=https://example.com\nNEXT_PUBLIC_STRIPE_SECRET_KEY=replace-me\n',
      '.env.local': 'NEXT_PUBLIC_DB_PASSWORD=replace-me\n',
      '.env.production': 'export NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY=replace-me\n',
    })
    const findings = result.findings.filter(f => f.ruleId === 'next-public-sensitive')
    expect(findings.map(f => `${f.file}:${f.line}`)).toEqual(['.env:2', '.env.local:1', '.env.production:1'])
  })

  it('skips # comments in .env files', () => {
    const file = makeFile('# Never name it NEXT_PUBLIC_SECRET_KEY\nNEXT_PUBLIC_API_URL=/api', { relativePath: '.env', ext: 'env' })
    const findings = nextPublicSensitiveRule.check(file, project)
    expect(findings).toHaveLength(0)
  })
})
