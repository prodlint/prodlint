import { describe, it, expect } from 'vitest'
import { staleFallbackRule } from '../../src/rules/stale-fallback.js'
import { makeFile, makeProject } from '../helpers.js'

const project = makeProject()

describe('stale-fallback rule', () => {
  it('detects hardcoded localhost URL', () => {
    const file = makeFile(`const url = "http://localhost:3000"`, { relativePath: 'src/lib/api.ts' })
    const findings = staleFallbackRule.check(file, project)
    expect(findings).toHaveLength(1)
    expect(findings[0].message).toContain('localhost')
  })

  it('detects Redis localhost', () => {
    const file = makeFile(`const redis = "redis://localhost"`, { relativePath: 'src/lib/cache.ts' })
    const findings = staleFallbackRule.check(file, project)
    expect(findings).toHaveLength(1)
  })

  it('detects MongoDB localhost', () => {
    const file = makeFile(`const db = "mongodb://localhost"`, { relativePath: 'src/db.ts' })
    const findings = staleFallbackRule.check(file, project)
    expect(findings).toHaveLength(1)
  })

  it('skips test files', () => {
    const file = makeFile(`const url = "http://localhost:3000"`, { relativePath: 'tests/api.test.ts' })
    const findings = staleFallbackRule.check(file, project)
    expect(findings).toHaveLength(0)
  })

  it('skips config files', () => {
    const file = makeFile(`const url = "http://localhost:3000"`, { relativePath: 'next.config.js' })
    const findings = staleFallbackRule.check(file, project)
    expect(findings).toHaveLength(0)
  })

  it('skips script files', () => {
    const file = makeFile(`const url = "http://localhost:3000"`, { relativePath: 'scripts/seed.ts' })
    const findings = staleFallbackRule.check(file, project)
    expect(findings).toHaveLength(0)
  })
})
