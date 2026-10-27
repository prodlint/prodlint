import { describe, it, expect } from 'vitest'
import { deadExportsRule } from '../../src/rules/dead-exports.js'
import { makeFile, makeProject, scanFiles } from '../helpers.js'

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

  it('skips Next.js special files (opengraph-image, sitemap, robots, etc.)', () => {
    const og = makeFile('export default function Image() {}', { relativePath: 'app/opengraph-image.tsx', ext: 'tsx' })
    const sitemap = makeFile('export default function sitemap() {}', { relativePath: 'app/sitemap.ts', ext: 'ts' })
    const robots = makeFile('export default function robots() {}', { relativePath: 'app/robots.ts', ext: 'ts' })
    const twitter = makeFile('export default function Image() {}', { relativePath: 'app/twitter-image.tsx', ext: 'tsx' })
    const icon = makeFile('export default function Icon() {}', { relativePath: 'app/icon.tsx', ext: 'tsx' })
    const manifest = makeFile('export default function manifest() {}', { relativePath: 'app/manifest.ts', ext: 'ts' })
    const other = makeFile('const x = 1', { relativePath: 'src/app.ts' })

    const findings = deadExportsRule.checkProject!([og, sitemap, robots, twitter, icon, manifest, other], project)
    expect(findings).toHaveLength(0)
  })

  it('skips export keywords inside string literals', () => {
    const exporter = makeFile([
      'export const RULES_DATA = [',
      '  {',
      '    example: `export const foo = 1',
      'export function bar() {}`,',
      '  }',
      ']',
    ].join('\n'), { relativePath: 'src/data.ts' })

    const consumer = makeFile(`import { RULES_DATA } from './data'`, { relativePath: 'src/app.ts' })

    const findings = deadExportsRule.checkProject!([exporter, consumer], project)
    expect(findings).toHaveLength(0)
  })

  it('does not collide symbols across files with same name', () => {
    // Two files both export 'format', only one is imported
    const fileA = makeFile('export const format = (x: string) => x.trim()', { relativePath: 'src/string-utils.ts' })
    const fileB = makeFile('export const format = (d: Date) => d.toISOString()', { relativePath: 'src/date-utils.ts' })

    // Many more exports to cross threshold
    const fileC = makeFile([
      'export const a1 = 1',
      'export const a2 = 2',
      'export const a3 = 3',
      'export const a4 = 4',
      'export const a5 = 5',
    ].join('\n'), { relativePath: 'src/extra.ts' })

    // Only imports format from string-utils, not date-utils
    const consumer = makeFile(`import { format } from './string-utils'`, { relativePath: 'src/app.ts' })

    const findings = deadExportsRule.checkProject!([fileA, fileB, fileC, consumer], project)
    // fileB's format should be counted as dead, plus all 5 from fileC = 6 dead
    expect(findings).toHaveLength(1)
    expect(findings[0].message).toContain('exported symbols never imported')
  })

  const sixExports = makeFile([
    'export const alpha = 1',
    'export const beta = 2',
    'export const gamma = 3',
    'export const delta = 4',
    'export function epsilon() {}',
    'export function zeta() {}',
  ].join('\n'), { relativePath: 'lib/utils.ts' })

  it('reads imports that span several lines', () => {
    const consumer = makeFile([
      'import {',
      '  alpha,',
      '  beta, // the second one',
      '  gamma,',
      '  delta as d,',
      '  epsilon,',
      '  zeta,',
      "} from '@/lib/utils'",
    ].join('\n'), { relativePath: 'app/dashboard/page.tsx', ext: 'tsx' })

    const findings = deadExportsRule.checkProject!([sixExports, consumer], project)
    expect(findings).toHaveLength(0)
  })

  it('reads named imports that follow a default import', () => {
    const consumer = makeFile(
      `import utils, { alpha, beta, gamma, delta, epsilon, zeta } from '../lib/utils'`,
      { relativePath: 'src/app.ts' },
    )

    const findings = deadExportsRule.checkProject!([sixExports, consumer], project)
    expect(findings).toHaveLength(0)
  })

  it('counts a namespace import as using every export of that module', () => {
    const consumer = makeFile(
      `import * as utils from '@/lib/utils'\nutils.alpha()`,
      { relativePath: 'src/app.ts' },
    )

    const findings = deadExportsRule.checkProject!([sixExports, consumer], project)
    expect(findings).toHaveLength(0)
  })

  // Next.js 16 renamed middleware.ts to proxy.ts. Next.js imports its `proxy` and `config`
  // itself, but only from an app's root or its src/.
  describe('Next.js 16 proxy', () => {
    const helpers = [
      'export const one = 1',
      'export const two = 2',
      'export const three = 3',
    ].join('\n')

    const proxy = [
      "import { NextResponse } from 'next/server'",
      '',
      'export function proxy(request) {',
      '  return NextResponse.next()',
      '}',
      '',
      "export const config = { matcher: ['/dashboard/:path*'] }",
    ].join('\n')

    // Three dead exports in lib/helpers.ts: under the threshold alone, at it with the proxy's two
    const check = (relativePath: string, allFiles: string[] = []) => deadExportsRule.checkProject!(
      [makeFile(helpers, { relativePath: 'lib/helpers.ts' }), makeFile(proxy, { relativePath })],
      makeProject({ allFiles }),
    )

    it.each(['proxy.ts', 'proxy.js', 'src/proxy.ts', 'src/proxy.tsx'])('skips %s at the scanned root', (path) => {
      expect(check(path)).toHaveLength(0)
    })

    it.each(['apps/web/proxy.ts', 'apps/web/src/proxy.ts'])('skips %s in an app with its own package.json', (path) => {
      expect(check(path, ['package.json', 'apps/web/package.json'])).toHaveLength(0)
    })

    // `proxy` is also a common module name: Supabase's Next.js template keeps its
    // session helper in lib/supabase/proxy.ts
    it.each([
      { path: 'lib/supabase/proxy.ts', allFiles: ['package.json'] },
      { path: 'src/lib/proxy.ts', allFiles: ['package.json'] },
      { path: 'apps/web/proxy.ts', allFiles: ['package.json'] },
      { path: 'apps/web/lib/proxy.ts', allFiles: ['package.json', 'apps/web/package.json'] },
      { path: 'apps/web/src/lib/proxy.ts', allFiles: ['package.json', 'apps/web/package.json'] },
    ])('still checks $path', ({ path, allFiles }) => {
      const findings = check(path, allFiles)
      expect(findings).toHaveLength(1)
      expect(findings[0].message).toMatch(/^5 exported symbols/)
      expect(findings[0].message).toContain(`${path} (2)`)
    })

    // Through the scanner: app roots come from the package.json files it walked
    it('finds app roots from the package.json files in the scan', async () => {
      const files = {
        'apps/web/proxy.ts': proxy,
        'apps/web/lib/helpers.ts': helpers,
      }
      const deadExports = async (extra: Record<string, string>) =>
        (await scanFiles({ ...files, ...extra })).findings.filter(f => f.ruleId === 'dead-exports')

      expect(await deadExports({ 'apps/web/package.json': '{}' })).toHaveLength(0)
      expect(await deadExports({})).toHaveLength(1)
    })
  })
})
