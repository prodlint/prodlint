import { describe, it, expect } from 'vitest'
import { noDynamicImportLoopRule } from '../../src/rules/no-dynamic-import-loop.js'
import { makeFile, makeProject } from '../helpers.js'

const project = makeProject()

describe('no-dynamic-import-loop rule', () => {
  it('detects import() inside for loop', () => {
    const file = makeFile([
      'for (const mod of modules) {',
      '  const m = await import(`./plugins/${mod}`)',
      '}',
    ].join('\n'))
    const findings = noDynamicImportLoopRule.check(file, project)
    expect(findings).toHaveLength(1)
    expect(findings[0].message).toContain('import()')
  })

  it('detects import() inside forEach', () => {
    const file = makeFile([
      'names.forEach(async (name) => {',
      '  const mod = await import(name)',
      '})',
    ].join('\n'))
    const findings = noDynamicImportLoopRule.check(file, project)
    expect(findings).toHaveLength(1)
  })

  it('detects import() inside while loop', () => {
    const file = makeFile([
      'while (i < plugins.length) {',
      '  const mod = await import(plugins[i])',
      '  i++',
      '}',
    ].join('\n'))
    const findings = noDynamicImportLoopRule.check(file, project)
    expect(findings).toHaveLength(1)
  })

  it('detects import() inside .map()', () => {
    const file = makeFile([
      'const results = plugins.map(async (p) => {',
      '  return import(`./plugins/${p}`)',
      '})',
    ].join('\n'))
    const findings = noDynamicImportLoopRule.check(file, project)
    expect(findings).toHaveLength(1)
  })

  it('ignores import() outside loops', () => {
    const file = makeFile(`const mod = await import('./plugin')`)
    const findings = noDynamicImportLoopRule.check(file, project)
    expect(findings).toHaveLength(0)
  })

  it('ignores static imports inside loops', () => {
    const file = makeFile([
      'for (const x of items) {',
      '  console.log(x)',
      '}',
    ].join('\n'))
    const findings = noDynamicImportLoopRule.check(file, project)
    expect(findings).toHaveLength(0)
  })

  it('returns empty for clean code', () => {
    const file = makeFile('export const x = 1')
    const findings = noDynamicImportLoopRule.check(file, project)
    expect(findings).toHaveLength(0)
  })
})
