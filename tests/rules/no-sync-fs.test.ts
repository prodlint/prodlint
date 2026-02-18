import { describe, it, expect } from 'vitest'
import { noSyncFsRule } from '../../src/rules/no-sync-fs.js'
import { makeFile, makeProject } from '../helpers.js'

const project = makeProject()

describe('no-sync-fs rule', () => {
  it('detects readFileSync in source files', () => {
    const file = makeFile(`const data = readFileSync('file.txt')`, { relativePath: 'src/utils/loader.ts' })
    const findings = noSyncFsRule.check(file, project)
    expect(findings).toHaveLength(1)
    expect(findings[0].message).toContain('readFileSync')
  })

  it('detects existsSync', () => {
    const file = makeFile(`if (existsSync(path)) {}`, { relativePath: 'src/lib/check.ts' })
    const findings = noSyncFsRule.check(file, project)
    expect(findings).toHaveLength(1)
  })

  it('reports warning severity for API routes', () => {
    const file = makeFile(`readFileSync('x')`, { relativePath: 'app/api/data/route.ts' })
    const findings = noSyncFsRule.check(file, project)
    expect(findings).toHaveLength(1)
    expect(findings[0].severity).toBe('warning')
  })

  it('skips test files', () => {
    const file = makeFile(`readFileSync('fixture.json')`, { relativePath: 'tests/load.test.ts' })
    const findings = noSyncFsRule.check(file, project)
    expect(findings).toHaveLength(0)
  })

  it('skips config files', () => {
    const file = makeFile(`readFileSync('key.pem')`, { relativePath: 'next.config.js' })
    const findings = noSyncFsRule.check(file, project)
    expect(findings).toHaveLength(0)
  })

  it('skips scripts', () => {
    const file = makeFile(`readFileSync('data.json')`, { relativePath: 'scripts/seed.ts' })
    const findings = noSyncFsRule.check(file, project)
    expect(findings).toHaveLength(0)
  })
})
