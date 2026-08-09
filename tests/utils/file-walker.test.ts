import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { buildProjectContext } from '../../src/utils/file-walker.js'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'prodlint-walker-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function writeJson(relPath: string, value: unknown) {
  const full = join(dir, relPath)
  mkdirSync(join(full, '..'), { recursive: true })
  writeFileSync(full, JSON.stringify(value, null, 2))
}

describe('buildProjectContext — dependency discovery', () => {
  it('collects dependencies from the root package.json', async () => {
    writeJson('package.json', { name: 'root', dependencies: { 'fast-glob': '^3.0.0' } })

    const project = await buildProjectContext(dir, [])

    expect(project.declaredDependencies.has('fast-glob')).toBe(true)
  })

  it('merges deps from declared workspaces', async () => {
    writeJson('package.json', { name: 'root', workspaces: ['packages/*'] })
    writeJson('packages/api/package.json', { name: '@org/api', dependencies: { zod: '^4.0.0' } })

    const project = await buildProjectContext(dir, [])

    expect(project.declaredDependencies.has('zod')).toBe(true)
    expect(project.declaredDependencies.has('@org/api')).toBe(true)
  })

  it('merges deps from nested packages with no workspaces field', async () => {
    // No `workspaces` key: a plain nested package still declares real dependencies,
    // so imports inside it must not be reported as hallucinated.
    writeJson('package.json', { name: 'root' })
    writeJson('packages/launcher/package.json', {
      name: 'root-launcher',
      dependencies: { root: '^1.0.0' },
    })

    const project = await buildProjectContext(dir, [])

    expect(project.declaredDependencies.has('root')).toBe(true)
    expect(project.declaredDependencies.has('root-launcher')).toBe(true)
  })

  it('ignores nested package.json files inside node_modules', async () => {
    writeJson('package.json', { name: 'root' })
    writeJson('node_modules/sneaky/package.json', {
      name: 'sneaky',
      dependencies: { 'should-not-leak': '^1.0.0' },
    })

    const project = await buildProjectContext(dir, [])

    expect(project.declaredDependencies.has('should-not-leak')).toBe(false)
  })

  it('survives an unparseable nested package.json', async () => {
    writeJson('package.json', { name: 'root', dependencies: { zod: '^4.0.0' } })
    mkdirSync(join(dir, 'packages', 'broken'), { recursive: true })
    writeFileSync(join(dir, 'packages', 'broken', 'package.json'), '{ not json')

    const project = await buildProjectContext(dir, [])

    expect(project.declaredDependencies.has('zod')).toBe(true)
  })
})
