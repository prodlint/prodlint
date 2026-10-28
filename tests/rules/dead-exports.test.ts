import { describe, it, expect } from 'vitest'
import { deadExportsRule } from '../../src/rules/dead-exports.js'
import type { FileContext, ProjectContext } from '../../src/types.js'
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

  // lib/padding.ts's five unused exports put every check over the threshold, so the finding
  // lists each file that has dead exports, with its count
  const padding = makeFile(
    ['one', 'two', 'three', 'four', 'five'].map(n => `export const ${n} = 1`).join('\n'),
    { relativePath: 'lib/padding.ts' },
  )

  /** File → its dead exports, read from the finding; lib/padding.ts is left out */
  const deadByFile = (files: FileContext[], proj: ProjectContext = project): Record<string, number> => {
    const [finding] = deadExportsRule.checkProject!([padding, ...files], proj)
    const listed = finding.message.split('Top files: ')[1]
    return Object.fromEntries([...listed.matchAll(/(\S+) \((\d+)\)/g)]
      .filter(m => m[1] !== 'lib/padding.ts')
      .map(m => [m[1], Number(m[2])]))
  }

  // Which imports use which exports
  describe('import resolution', () => {
    it('does not count a package import as using a project export of the same name', () => {
      const store = makeFile('export const proxy = (value) => value', { relativePath: 'lib/store.ts' })
      const consumer = makeFile(`import { proxy } from 'valtio'`, { relativePath: 'app/state.ts' })
      const withValtio = makeProject({ declaredDependencies: new Set(['valtio']) })
      expect(deadByFile([store, consumer], withValtio)).toEqual({ 'lib/store.ts': 1 })
    })

    it.each(['node:path', 'path', 'npm:pathe', 'https://deno.land/std/path/mod.ts'])(
      'does not count an import from %s as using a project export',
      (source) => {
        const paths = makeFile('export function join() {}', { relativePath: 'lib/paths.ts' })
        const consumer = makeFile(`import { join } from '${source}'`, { relativePath: 'app/files.ts' })
        expect(deadByFile([paths, consumer])).toEqual({ 'lib/paths.ts': 1 })
      },
    )

    it('does not count an import as using a same-named export in another file', () => {
      const config = makeFile('export const config = { retries: 3 }', { relativePath: 'lib/config.ts' })
      const upload = makeFile('export const config = { maxSize: 10 }', { relativePath: 'lib/upload.ts' })
      const consumer = makeFile(`import { config } from './config'`, { relativePath: 'lib/client.ts' })
      expect(deadByFile([config, upload, consumer])).toEqual({ 'lib/upload.ts': 1 })
    })

    it('resolves a relative import to one file, not to every file with that name', () => {
      const web = makeFile('export function format() {}', { relativePath: 'apps/web/lib/utils.ts' })
      const docs = makeFile('export function format() {}', { relativePath: 'apps/docs/lib/utils.ts' })
      const consumer = makeFile(`import { format } from '../lib/utils'`, { relativePath: 'apps/web/components/date.tsx' })
      expect(deadByFile([web, docs, consumer])).toEqual({ 'apps/docs/lib/utils.ts': 1 })
    })

    it('matches an @/ import by its path, not just its file name', () => {
      const web = makeFile('export function format() {}', { relativePath: 'apps/web/lib/utils.ts' })
      const ui = makeFile('export function format() {}', { relativePath: 'packages/ui/src/utils.ts' })
      const consumer = makeFile(`import { format } from '@/lib/utils'`, { relativePath: 'apps/web/components/date.tsx' })
      expect(deadByFile([web, ui, consumer])).toEqual({ 'packages/ui/src/utils.ts': 1 })
    })

    it.each([
      { source: './format.js', path: 'lib/format.ts', from: 'lib/date.ts' }, // TypeScript's ESM style
      { source: './format', path: 'lib/format.tsx', from: 'lib/date.ts' },
      { source: '../lib/format', path: 'lib/format.ts', from: 'app/date.ts' },
      { source: '@/lib/format', path: 'src/lib/format.ts', from: 'src/app/date.ts' },
      { source: '~/lib/format', path: 'lib/format.ts', from: 'app/date.ts' },
      { source: '@components/format', path: 'src/components/format.ts', from: 'src/app/date.ts' },
      { source: 'components/format', path: 'src/components/format.ts', from: 'src/app/date.ts' }, // baseUrl
    ])('counts an import from $source in $from as using $path', ({ source, path, from }) => {
      const format = makeFile('export function format() {}', { relativePath: path })
      const consumer = makeFile(`import { format } from '${source}'`, { relativePath: from })
      expect(deadByFile([format, consumer])).toEqual({})
    })

    it('counts a default import as using the export of the same name', () => {
      // export const Chart … export default Chart
      const chart = makeFile('export const Chart = () => null\nexport default Chart', { relativePath: 'lib/chart.ts' })
      const consumer = makeFile(`import Chart from './chart'`, { relativePath: 'lib/report.ts' })
      expect(deadByFile([chart, consumer])).toEqual({})
    })

    describe('modules loaded with import() or require()', () => {
      const chart = makeFile('export function renderChart() {}\nexport class Chart {}', { relativePath: 'lib/chart.ts' })
      const load = (code: string) => deadByFile([chart, makeFile(code, { relativePath: 'lib/report.ts' })])

      it.each([
        `const chart = await import('./chart')`,
        `const Chart = dynamic(() => import('@/lib/chart').then(m => m.Chart))`,
        `const chart = require('./chart')`,
      ])('counts every export of the module for %s', (code) => {
        expect(load(code)).toEqual({})
      })

      it.each([
        `const { renderChart } = await import('./chart')`,
        `const { renderChart: render } = require('./chart')`,
        `require('./chart').renderChart()`,
        `/** @type {import('./chart').Chart} */`,
      ])('counts just the export it names for %s', (code) => {
        expect(load(code)).toEqual({ 'lib/chart.ts': 1 })
      })

      it('counts nothing for typeof import(), a type', () => {
        expect(load(`type ChartModule = typeof import('./chart')`)).toEqual({ 'lib/chart.ts': 2 })
      })

      // shadcn/ui loads its icon sets with import(`./__${libraryName}__`)
      it('counts every module a template literal can load', () => {
        const files = [
          makeFile('export const ArrowIcon = 1\nexport const CheckIcon = 2', { relativePath: 'registry/icons/__lucide__.ts' }),
          makeFile('export const ArrowIcon = 1', { relativePath: 'registry/icons/__tabler__.ts' }),
          makeFile('export function iconName() {}', { relativePath: 'registry/icons/names.ts' }),
          makeFile('const load = (library) => import(`./__${library}__`)', { relativePath: 'registry/icons/loader.tsx' }),
        ]
        expect(deadByFile(files)).toEqual({ 'registry/icons/names.ts': 1 })
      })
    })

    it('still counts a name imported from a source no scanned file matches', () => {
      // '@acme/ui' is neither a declared dependency nor a package in the scan: an alias, say
      const button = makeFile('export function Button() {}', { relativePath: 'packages/ui/src/button.tsx' })
      const consumer = makeFile(`import { Button } from '@acme/ui'`, { relativePath: 'app/form.tsx' })
      expect(deadByFile([button, consumer])).toEqual({})
    })

    // fumadocs generates .source/, which re-exports source.config.ts; a scan seldom has it
    it.each(['@/.source', './.source'])('still counts a name imported from a generated folder, %s', (source) => {
      const config = makeFile('export const docs = defineDocs({ dir: "content" })', { relativePath: 'source.config.ts' })
      const consumer = makeFile(`import { docs } from '${source}'`, { relativePath: 'lib/source.ts' })
      expect(deadByFile([config, consumer])).toEqual({})
    })

    // create-t3-app's templates import ~/server/api/trpc, the file they become once generated
    it('still counts a name anywhere when an alias matches a file name but none of its folders', () => {
      const installer = makeFile('export const trpcInstaller = 1', { relativePath: 'cli/src/installers/trpc.ts' })
      const template = makeFile('export const createTRPCRouter = 1', { relativePath: 'cli/template/src/server/api/trpc-base.ts' })
      const consumer = makeFile(`import { createTRPCRouter } from '~/server/api/trpc'`, { relativePath: 'cli/template/src/server/api/root.ts' })
      expect(deadByFile([installer, template, consumer])).toEqual({ 'cli/src/installers/trpc.ts': 1 })
    })

    describe('package entry points', () => {
      const client = makeFile('export function createClient() {}\nexport function internalHelper() {}', { relativePath: 'packages/sdk/src/client.ts' })
      const index = makeFile(`export { createClient } from './client'`, { relativePath: 'packages/sdk/src/index.ts' })
      const manifest = (fields: Record<string, unknown>) =>
        makeFile(JSON.stringify({ name: '@acme/sdk', ...fields }), { relativePath: 'packages/sdk/package.json' })

      // Built from src/: dist/index.js stands for src/index.ts
      it.each([
        { main: './dist/index.js' },
        { exports: { '.': { types: './dist/index.d.ts', import: './dist/index.mjs' } } },
        { types: './dist/index.d.ts' },
      ])('counts what a published package re-exports from its entry point, given %j', (fields) => {
        expect(deadByFile([manifest(fields), index, client])).toEqual({ 'packages/sdk/src/client.ts': 1 })
      })

      it('skips the exports of a published package entry point that is no index file', () => {
        const sdk = makeFile('export function createClient() {}', { relativePath: 'packages/sdk/src/sdk.ts' })
        expect(deadByFile([manifest({ exports: { '.': './dist/sdk.js' } }), sdk])).toEqual({})
      })

      // A workspace's own packages: private, or naming TypeScript source no npm user could run.
      // What their index re-exports counts once something imports it
      it.each([{ private: true, main: './dist/index.js' }, { main: './src/index.ts' }, {}])(
        'counts the re-exports of a package entry point only as far as something imports them, given %j',
        (fields) => {
          expect(deadByFile([manifest(fields), index, client])).toEqual({ 'packages/sdk/src/client.ts': 2 })
        },
      )
    })

    it('counts what a Next.js route re-exports, since Next.js imports the route', () => {
      const auth = makeFile('export const GET = 1\nexport const POST = 2\nexport const authOptions = {}', { relativePath: 'lib/auth.ts' })
      const route = makeFile(`export { GET, POST } from '@/lib/auth'`, { relativePath: 'app/api/auth/[...nextauth]/route.ts' })
      expect(deadByFile([auth, route])).toEqual({ 'lib/auth.ts': 1 })
    })

    it('counts an import from a workspace package against that package only', () => {
      const files = [
        makeFile(JSON.stringify({ name: '@acme/ui' }), { relativePath: 'packages/ui/package.json' }),
        makeFile(`export * from './button'`, { relativePath: 'packages/ui/src/index.ts' }),
        makeFile('export function Button() {}', { relativePath: 'packages/ui/src/button.tsx' }),
        makeFile('export function Button() {}', { relativePath: 'apps/web/components/button.tsx' }),
        makeFile(`import { Button } from '@acme/ui'`, { relativePath: 'apps/web/app/form.tsx' }),
      ]
      // A scan declares workspace packages as dependencies too
      const withUi = makeProject({ declaredDependencies: new Set(['@acme/ui']) })
      expect(deadByFile(files, withUi)).toEqual({ 'apps/web/components/button.tsx': 1 })
    })

    describe('re-exports', () => {
      const lib = [
        makeFile([
          `export { alpha } from './alpha'`,
          `export { internal as beta } from './beta'`,
          `export * from './gamma'`,
          `export * as delta from './delta'`,
        ].join('\n'), { relativePath: 'lib/index.ts' }),
        makeFile('export const alpha = 1\nexport const alphaHelper = 2', { relativePath: 'lib/alpha.ts' }),
        makeFile('export const internal = 1', { relativePath: 'lib/beta.ts' }),
        makeFile('export const gamma = 1\nexport const gammaHelper = 2', { relativePath: 'lib/gamma.ts' }),
        makeFile('export const d1 = 1\nexport const d2 = 2', { relativePath: 'lib/delta.ts' }),
      ]

      it.each(['@/lib', '../lib'])('follows a barrel imported as %s to the modules it re-exports', (source) => {
        const consumer = makeFile(`import { alpha, beta, gamma, delta } from '${source}'`, { relativePath: 'app/data.ts' })
        expect(deadByFile([...lib, consumer])).toEqual({ 'lib/alpha.ts': 1, 'lib/gamma.ts': 1 })
      })

      it('counts no re-exported name that nothing imports through the barrel', () => {
        const consumer = makeFile(`import { alpha, gamma } from 'valtio'`, { relativePath: 'app/data.ts' })
        const withValtio = makeProject({ declaredDependencies: new Set(['valtio']) })
        expect(deadByFile([...lib, consumer], withValtio))
          .toEqual({ 'lib/alpha.ts': 2, 'lib/beta.ts': 1, 'lib/gamma.ts': 2, 'lib/delta.ts': 2 })
      })

      it('follows a chain of barrels, and stops at a cycle', () => {
        const files = [
          makeFile(`export * from './ui'`, { relativePath: 'components/index.ts' }),
          makeFile(`export * from './button'\nexport * from '..'`, { relativePath: 'components/ui/index.ts' }),
          makeFile('export function Button() {}\nexport function ButtonGroup() {}', { relativePath: 'components/ui/button.tsx' }),
          makeFile(`import { Button } from '../components'`, { relativePath: 'app/form.tsx' }),
        ]
        expect(deadByFile(files)).toEqual({ 'components/ui/button.tsx': 1 })
      })
    })

    // Through the scanner: package names and dependencies come from the walked package.json files
    it('reads package names and dependencies from the scan', async () => {
      const result = await scanFiles({
        'package.json': JSON.stringify({ dependencies: { valtio: '^2.0.0', '@acme/ui': 'workspace:*' } }),
        'packages/ui/package.json': JSON.stringify({ name: '@acme/ui' }),
        'packages/ui/src/index.ts': `export * from './button'`,
        'packages/ui/src/button.tsx': 'export function Button() {}',
        'lib/store.ts': ['proxy', 'a', 'b', 'c', 'd'].map(n => `export const ${n} = 1`).join('\n'),
        'app/form.tsx': `import { proxy } from 'valtio'\nimport { Button } from '@acme/ui'`,
      })
      const deadExports = result.findings.filter(f => f.ruleId === 'dead-exports')
      expect(deadExports).toHaveLength(1)
      expect(deadExports[0].message).toMatch(/^5 exported symbols/)
      expect(deadExports[0].message).toContain('lib/store.ts (5)')
    })
  })

  // The Pages Router: Next.js routes every module under pages/ (or src/pages/) at an app's root,
  // and reads their exports itself: the page, getServerSideProps, an API route's config
  describe('Next.js Pages Router', () => {
    const route = (relativePath: string) => makeFile(
      'export const config = { api: { bodyParser: false } }\nexport async function getServerSideProps() {}',
      { relativePath },
    )
    const monorepo = makeProject({ allFiles: ['package.json', 'apps/web/package.json'] })

    it.each(['pages/api/upload.ts', 'pages/blog/[slug].tsx', 'src/pages/_app.tsx', 'apps/web/pages/settings.tsx'])(
      'skips %s',
      (path) => {
        expect(deadByFile([route(path)], monorepo)).toEqual({})
      },
    )

    it.each(['components/pages/home.tsx', 'apps/web/lib/pages/auth.ts', 'apps/docs/pages/index-helpers.ts'])(
      'still checks %s',
      (path) => {
        expect(deadByFile([route(path)], monorepo)).toEqual({ [path]: 2 })
      },
    )

    // calcom's pages/api/integrations/*/webhook.ts are `export { default } from '…'` and a config
    it('counts what a route re-exports', () => {
      const webhook = makeFile(
        'export const config = {}\nexport function verifySignature() {}\nconst handler = () => {}\nexport { handler as default }',
        { relativePath: 'lib/webhook.ts' },
      )
      const shim = makeFile(`export { default, config } from '@/lib/webhook'`, { relativePath: 'pages/api/webhook.ts' })
      expect(deadByFile([webhook, shim])).toEqual({ 'lib/webhook.ts': 1 })
    })
  })

  // SvelteKit keeps the + prefix for its route files, and reads their exports itself
  it.each(['src/routes/+page.server.ts', 'src/routes/+layout.ts', 'src/routes/api/+server.js'])(
    'skips SvelteKit route file %s',
    (path) => {
      const file = makeFile('export const load = async () => ({})\nexport const GET = async () => new Response()', { relativePath: path })
      expect(deadByFile([file])).toEqual({})
    },
  )

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
