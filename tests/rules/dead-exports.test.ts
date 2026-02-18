import { describe, it, expect } from 'vitest'
import { deadExportsRule } from '../../src/rules/dead-exports.js'
import { makeFile, makeProject } from '../helpers.js'

const project = makeProject()

describe('dead-exports rule', () => {
  it('flags dead exports above threshold', () => {
    const exporter = makeFile([
      'export const foo = 1',
      'export const bar = 2',
      'export const baz = 3',
      'export const qux = 4',
      'export const quux = 5',
      'export const corge = 6',
    ].join('\n'), { relativePath: 'src/utils.ts' })

    const consumer = makeFile(`import { foo } from './utils'`, { relativePath: 'src/app.ts' })

    const findings = deadExportsRule.checkProject!([exporter, consumer], project)
    expect(findings).toHaveLength(1)
    expect(findings[0].message).toContain('exported symbols never imported')
  })

  it('allows when all exports are consumed', () => {
    const exporter = makeFile([
      'export const foo = 1',
      'export const bar = 2',
    ].join('\n'), { relativePath: 'src/utils.ts' })

    const consumer = makeFile(`import { foo, bar } from './utils'`, { relativePath: 'src/app.ts' })

    const findings = deadExportsRule.checkProject!([exporter, consumer], project)
    expect(findings).toHaveLength(0)
  })

  it('skips entry point files', () => {
    const page = makeFile('export const metadata = {}', { relativePath: 'app/page.tsx', ext: 'tsx' })
    const other = makeFile('const x = 1', { relativePath: 'src/app.ts' })

    const findings = deadExportsRule.checkProject!([page, other], project)
    expect(findings).toHaveLength(0)
  })

  it('skips index files (barrel exports)', () => {
    const barrel = makeFile([
      'export const a = 1',
      'export const b = 2',
      'export const c = 3',
      'export const d = 4',
      'export const e = 5',
      'export const f = 6',
    ].join('\n'), { relativePath: 'src/components/index.ts' })

    const findings = deadExportsRule.checkProject!([barrel], project)
    expect(findings).toHaveLength(0)
  })

  it('skips type exports', () => {
    const exporter = makeFile([
      'export type Foo = { a: string }',
      'export interface Bar { b: number }',
    ].join('\n'), { relativePath: 'src/types.ts' })

    const findings = deadExportsRule.checkProject!([exporter], project)
    expect(findings).toHaveLength(0)
  })

  it('counts imports from test files as consumed', () => {
    const exporter = makeFile([
      'export const foo = 1',
      'export const bar = 2',
      'export const baz = 3',
      'export const qux = 4',
      'export const quux = 5',
      'export const corge = 6',
    ].join('\n'), { relativePath: 'src/utils.ts' })

    const testConsumer = makeFile(
      `import { foo, bar, baz, qux, quux, corge } from '../src/utils'`,
      { relativePath: 'tests/utils.test.ts' },
    )

    const findings = deadExportsRule.checkProject!([exporter, testConsumer], project)
    expect(findings).toHaveLength(0)
  })

  it('reports top offending files', () => {
    const exporter = makeFile([
      'export const a1 = 1',
      'export const a2 = 2',
      'export const a3 = 3',
      'export const a4 = 4',
      'export const a5 = 5',
      'export const a6 = 6',
    ].join('\n'), { relativePath: 'src/big-utils.ts' })

    const findings = deadExportsRule.checkProject!([exporter], project)
    expect(findings).toHaveLength(1)
    expect(findings[0].message).toContain('big-utils.ts')
  })

  it('does not flag below threshold', () => {
    const exporter = makeFile([
      'export const foo = 1',
      'export const bar = 2',
      'export const baz = 3',
    ].join('\n'), { relativePath: 'src/utils.ts' })

    const findings = deadExportsRule.checkProject!([exporter], project)
    expect(findings).toHaveLength(0)
  })
})
