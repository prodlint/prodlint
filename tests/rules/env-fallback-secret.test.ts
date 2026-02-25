import { describe, it, expect } from 'vitest'
import { envFallbackSecretRule } from '../../src/rules/env-fallback-secret.js'
import { makeFile, makeProject } from '../helpers.js'

const project = makeProject()

describe('env-fallback-secret rule', () => {
  it('detects JWT_SECRET with string fallback', () => {
    const file = makeFile(`const secret = process.env.JWT_SECRET || "supersecret"`)
    const findings = envFallbackSecretRule.check(file, project)
    expect(findings).toHaveLength(1)
    expect(findings[0].severity).toBe('critical')
  })

  it('detects AUTH_SECRET with fallback', () => {
    const file = makeFile(`const secret = process.env.AUTH_SECRET || "fallback"`)
    const findings = envFallbackSecretRule.check(file, project)
    expect(findings).toHaveLength(1)
    expect(findings[0].severity).toBe('critical')
  })

  it('detects generic SECRET_KEY with fallback', () => {
    const file = makeFile(`const key = process.env.MY_SECRET_KEY || "default-key"`)
    const findings = envFallbackSecretRule.check(file, project)
    expect(findings).toHaveLength(1)
  })

  it('allows env var without fallback', () => {
    const file = makeFile(`const secret = process.env.JWT_SECRET`)
    const findings = envFallbackSecretRule.check(file, project)
    expect(findings).toHaveLength(0)
  })

  it('allows non-sensitive env var with fallback', () => {
    const file = makeFile(`const port = process.env.PORT || "3000"`)
    const findings = envFallbackSecretRule.check(file, project)
    expect(findings).toHaveLength(0)
  })

  it('skips test files', () => {
    const file = makeFile(`const secret = process.env.JWT_SECRET || "test"`, { relativePath: 'tests/auth.test.ts' })
    const findings = envFallbackSecretRule.check(file, project)
    expect(findings).toHaveLength(0)
  })

  it('detects NEXTAUTH_SECRET with fallback', () => {
    const file = makeFile(`const secret = process.env.NEXTAUTH_SECRET || "dev-secret"`)
    const findings = envFallbackSecretRule.check(file, project)
    expect(findings).toHaveLength(1)
    expect(findings[0].severity).toBe('critical')
  })

  it('detects nullish coalescing fallback', () => {
    const file = makeFile(`const secret = process.env.JWT_SECRET ?? "default"`)
    const findings = envFallbackSecretRule.check(file, project)
    expect(findings).toHaveLength(1)
  })

  it('detects postgres connection string fallback', () => {
    const file = makeFile(`const db = process.env.DATABASE_URL || "postgres://user:pass@localhost:5432/mydb"`)
    const findings = envFallbackSecretRule.check(file, project)
    expect(findings).toHaveLength(1)
    expect(findings[0].message).toContain('Connection string')
  })

  it('detects mongodb connection string fallback', () => {
    const file = makeFile(`const mongo = process.env.MONGO_URI ?? "mongodb://localhost:27017/app"`)
    const findings = envFallbackSecretRule.check(file, project)
    expect(findings).toHaveLength(1)
  })

  it('detects redis connection string fallback', () => {
    const file = makeFile(`const redis = process.env.REDIS_URL || "redis://localhost:6379"`)
    const findings = envFallbackSecretRule.check(file, project)
    expect(findings).toHaveLength(1)
  })

  it('ignores non-connection-string fallback for generic env var', () => {
    const file = makeFile(`const url = process.env.APP_URL || "http://localhost:3000"`)
    const findings = envFallbackSecretRule.check(file, project)
    expect(findings).toHaveLength(0)
  })
})
