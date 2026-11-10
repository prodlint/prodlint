import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { buildProjectContext } from '../../src/utils/file-walker.js'
import { packageOf } from '../../src/utils/package-scope.js'
import { makeFile, makeProject } from '../helpers.js'
import type { ProjectContext } from '../../src/types.js'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'prodlint-packages-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

/**
 * Writes each package.json (folder → its content), or any other file by its path. `sources`
 * are the scanned files the context reads imports from (path → code)
 */
async function contextOf(files: Record<string, unknown>, sources: Record<string, string> = {}): Promise<ProjectContext> {
  for (const [path, value] of Object.entries(files)) {
    const isFile = typeof value === 'string'
    const full = isFile ? join(dir, path) : join(dir, path, 'package.json')
    mkdirSync(dirname(full), { recursive: true })
    writeFileSync(full, isFile ? value : JSON.stringify(value, null, 2))
  }
  const read = Object.entries(sources).map(([relativePath, code]) => makeFile(code, { relativePath }))
  return buildProjectContext(dir, [], read)
}

const deps = (...names: string[]) => Object.fromEntries(names.map(name => [name, '^1.0.0']))
const frameworks = (project: ProjectContext, file: string) => [...packageOf(project, file).frameworks].sort()

describe('package scopes — a nested package', () => {
  // The case that started this: a fixture app listing Prisma downgraded sql-injection
  // everywhere else in the repo
  it("keeps its frameworks to its own folder", async () => {
    const project = await contextOf({
      '': { name: 'app', dependencies: deps('pg') },
      'examples/demo': { name: 'demo', dependencies: deps('@prisma/client') },
    })

    expect(frameworks(project, 'src/users.ts')).toEqual([])
    expect(frameworks(project, 'examples/readme-snippet.ts')).toEqual([])
    expect(frameworks(project, 'examples/demo/index.ts')).toEqual(['prisma'])
    expect(frameworks(project, 'examples/demo/src/deep/query.ts')).toEqual(['prisma'])
    // The project's own are the root package's
    expect([...project.detectedFrameworks]).toEqual([])
  })

  it('still declares its dependencies for imports anywhere in the tree', async () => {
    const project = await contextOf({
      '': { name: 'app' },
      'examples/demo': { name: 'demo', dependencies: deps('@prisma/client') },
    })

    expect(project.declaredDependencies.has('@prisma/client')).toBe(true)
    expect(project.declaredDependencies.has('demo')).toBe(true)
    // The root's own name isn't something its files import
    expect(project.declaredDependencies.has('app')).toBe(false)
  })

  it('keeps the frameworks of the packages above it', async () => {
    const project = await contextOf({
      '': { name: 'app', dependencies: deps('drizzle-orm') },
      // A package.json that only sets the module type takes nothing away
      'scripts': { type: 'module' },
      'services/api': { name: 'api', dependencies: deps('express') },
      'services/api/fixtures/shop': { name: 'shop', dependencies: deps('lodash') },
    })

    expect(frameworks(project, 'scripts/seed.ts')).toEqual(['drizzle'])
    expect(frameworks(project, 'services/api/src/server.ts')).toEqual(['drizzle', 'express'])
    expect(frameworks(project, 'services/api/fixtures/shop/index.ts')).toEqual(['drizzle', 'express', 'lodash'])
    expect(frameworks(project, 'src/db.ts')).toEqual(['drizzle'])
  })

  it("isn't confused by a folder whose name starts the same", async () => {
    const project = await contextOf({
      'apps/web': { name: 'web', dependencies: deps('knex') },
      'apps/web-admin': { name: 'web-admin', dependencies: deps('mongoose') },
    })

    expect(frameworks(project, 'apps/web/db.ts')).toEqual(['knex'])
    expect(frameworks(project, 'apps/web-admin/db.ts')).toEqual(['mongoose'])
    expect(frameworks(project, 'apps/web-admin.config.ts')).toEqual([])
  })

  it('counts with no package.json at the root', async () => {
    const project = await contextOf({
      'backend': { name: 'backend', dependencies: deps('sequelize') },
      'frontend': { name: 'frontend', dependencies: deps('lodash') },
    })

    expect(project.packageJson).toBeNull()
    expect(frameworks(project, 'backend/models/user.js')).toEqual(['sequelize'])
    expect(frameworks(project, 'frontend/src/App.tsx')).toEqual(['lodash'])
    expect(frameworks(project, 'deploy.js')).toEqual([])
  })

  it('is skipped inside node_modules, and survives being unreadable', async () => {
    const project = await contextOf({
      '': { name: 'app', dependencies: deps('typeorm') },
      'node_modules/sneaky': { name: 'sneaky', dependencies: deps('mongoose') },
      'packages/broken/package.json': '{ not json',
    })

    expect(frameworks(project, 'node_modules/sneaky/index.js')).toEqual(['typeorm'])
    expect(frameworks(project, 'packages/broken/index.ts')).toEqual(['typeorm'])
  })
})

describe('package scopes — a declared workspace', () => {
  const monorepo = {
    'packages/db': { name: '@acme/db', dependencies: deps('@prisma/client') },
    'apps/web': { name: 'web', dependencies: deps('next-auth') },
    'apps/docs': { name: 'docs' },
    // Not in the workspace
    'examples/demo': { name: 'demo', dependencies: deps('mongoose') },
  }

  it('shares what its root and members declare, as before', async () => {
    const project = await contextOf({ '': { name: 'acme', workspaces: ['apps/*', 'packages/*'] }, ...monorepo })

    for (const file of ['apps/web/app/page.tsx', 'apps/docs/index.ts', 'packages/db/client.ts', 'turbo.config.ts']) {
      expect(frameworks(project, file), file).toEqual(['next-auth', 'prisma'])
    }
    expect([...project.detectedFrameworks].sort()).toEqual(['next-auth', 'prisma'])
    // One scope for all of them
    expect(packageOf(project, 'apps/web/app/page.tsx')).toBe(packageOf(project, 'packages/db/client.ts'))
  })

  it('reads yarn\'s `workspaces.packages` and pnpm-workspace.yaml', async () => {
    const yarn = await contextOf({ '': { name: 'acme', workspaces: { packages: ['apps/*', 'packages/*'] } }, ...monorepo })
    expect(frameworks(yarn, 'apps/docs/index.ts')).toEqual(['next-auth', 'prisma'])

    rmSync(dir, { recursive: true, force: true })
    const pnpm = await contextOf({
      '': { name: 'acme' },
      'pnpm-workspace.yaml': "packages:\n  - 'apps/*'\n  - packages/*\n",
      ...monorepo,
    })
    expect(frameworks(pnpm, 'apps/docs/index.ts')).toEqual(['next-auth', 'prisma'])
  })

  it("doesn't take in a package outside it, which still sees the workspace above it", async () => {
    const project = await contextOf({ '': { name: 'acme', workspaces: ['apps/*', 'packages/*'] }, ...monorepo })

    expect(frameworks(project, 'apps/web/app/page.tsx')).not.toContain('mongoose')
    expect(frameworks(project, 'examples/demo/index.ts')).toEqual(['mongoose', 'next-auth', 'prisma'])
  })

  // The first workspace merge put each member's name in with its dependencies
  it("counts a member's own name like a dependency", async () => {
    const project = await contextOf({
      '': { name: 'acme', workspaces: ['vendor/*', 'apps/*'] },
      'vendor/knex': { name: 'knex' },
      'apps/api': { name: 'api' },
    })

    expect(frameworks(project, 'apps/api/db.ts')).toEqual(['knex'])
  })

  it("doesn't take in what a workspace glob finds in node_modules", async () => {
    const project = await contextOf({
      '': { name: 'acme', workspaces: ['packages/**'] },
      'packages/web': { name: 'web', dependencies: deps('express') },
      'packages/web/node_modules/some-orm': { name: 'some-orm', dependencies: deps('sequelize') },
    })

    expect(frameworks(project, 'packages/web/index.ts')).toEqual(['express'])
  })

  it('takes in a member the workspace names in a dot folder', async () => {
    const project = await contextOf({
      '': { name: 'acme', workspaces: ['apps/*', 'apps/web/.emails'] },
      'apps/web': { name: 'web' },
      'apps/web/.emails': { name: 'emails', dependencies: deps('lodash') },
    })

    expect(frameworks(project, 'apps/web/app/page.tsx')).toEqual(['lodash'])
  })

  it('is one project below the root too', async () => {
    const project = await contextOf({
      '': { name: 'everything' },
      'platform': { name: 'platform', private: true, workspaces: ['packages/*'] },
      'platform/packages/db': { name: '@platform/db', dependencies: deps('drizzle-orm') },
      'platform/packages/web': { name: '@platform/web' },
      'site': { name: 'site' },
      // pnpm's, with no workspaces field in the package.json next to it
      'tools': { name: 'tools' },
      'tools/pnpm-workspace.yaml': 'packages:\n  - "*"\n',
      'tools/orm': { name: 'orm', dependencies: deps('knex') },
      'tools/cli': { name: 'cli' },
    })

    expect(frameworks(project, 'platform/packages/web/app/page.tsx')).toEqual(['drizzle'])
    expect(frameworks(project, 'platform/turbo.config.ts')).toEqual(['drizzle'])
    expect(frameworks(project, 'tools/cli/index.ts')).toEqual(['knex'])
    expect(frameworks(project, 'site/index.ts')).toEqual([])
    expect(frameworks(project, 'index.ts')).toEqual([])
  })
})

describe('package scopes — a dependency on a scanned package', () => {
  // No workspace declared: a `file:` link, Lerna's or Rush's own list, or a scan that starts
  // below the workspace root
  it('brings that package\'s frameworks, and the ones it depends on in turn', async () => {
    const project = await contextOf({
      'db': { name: '@acme/db', dependencies: deps('@prisma/client') },
      'api': { name: '@acme/api', dependencies: { '@acme/db': 'file:../db' } },
      'web': { name: 'web', dependencies: { '@acme/api': 'workspace:*' } },
      'docs': { name: 'docs', dependencies: deps('react') },
    })

    expect(frameworks(project, 'db/client.ts')).toEqual(['prisma'])
    expect(frameworks(project, 'api/src/users.ts')).toEqual(['prisma'])
    expect(frameworks(project, 'web/app/page.tsx')).toEqual(['prisma'])
    expect(frameworks(project, 'docs/index.ts')).toEqual([])
    expect(frameworks(project, 'index.ts')).toEqual([])
  })

  it('works from the root package and through dev and peer dependencies', async () => {
    const project = await contextOf({
      '': { name: 'app', devDependencies: { '@acme/db': 'file:./db' } },
      'db': { name: '@acme/db', peerDependencies: deps('drizzle-orm') },
      'plugins/audit': { name: 'audit', dependencies: deps('knex') },
    })

    expect(frameworks(project, 'src/index.ts')).toEqual(['drizzle'])
    expect(frameworks(project, 'plugins/audit/index.ts')).toEqual(['drizzle', 'knex'])
  })

  it('ends on packages that depend on each other', async () => {
    const project = await contextOf({
      'a': { name: 'a', dependencies: deps('b', 'lodash') },
      'b': { name: 'b', dependencies: deps('a', 'express') },
    })

    expect(frameworks(project, 'a/index.ts')).toEqual(['express', 'lodash'])
    expect(frameworks(project, 'b/index.ts')).toEqual(['express', 'lodash'])
  })

  // A name isn't an address: a fixture can be called what a real dependency is called
  it("brings what that package declares, not what's above it", async () => {
    const project = await contextOf({
      '': { name: 'app', dependencies: deps('ms') },
      'tests/fixtures': { name: 'fixtures', dependencies: deps('mongoose') },
      'tests/fixtures/ms': { name: 'ms', dependencies: deps('lodash') },
    })

    expect(frameworks(project, 'src/index.ts')).toEqual(['lodash'])
    expect(frameworks(project, 'tests/fixtures/ms/index.js')).toEqual(['lodash', 'mongoose'])
  })

  it('takes the whole workspace of a member it depends on', async () => {
    const project = await contextOf({
      'site': { name: 'site', dependencies: { '@platform/web': 'file:../platform/packages/web' } },
      'platform': { name: 'platform', workspaces: ['packages/*'] },
      'platform/packages/web': { name: '@platform/web' },
      'platform/packages/db': { name: '@platform/db', dependencies: deps('typeorm') },
    })

    expect(frameworks(project, 'site/pages/index.tsx')).toEqual(['typeorm'])
  })

  it("doesn't join two packages that only share a name", async () => {
    const project = await contextOf({
      'examples/with-prisma': { name: 'starter', dependencies: deps('@prisma/client') },
      'examples/plain': { name: 'starter' },
    })

    expect(frameworks(project, 'examples/plain/index.ts')).toEqual([])
    expect(frameworks(project, 'examples/with-prisma/index.ts')).toEqual(['prisma'])
  })
})

// A hoisted workspace lets a package import its sibling with nothing in its package.json. A
// scan that starts below the workspace's root sees no workspace, only the imports
describe('package scopes — an import of a scanned package', () => {
  const packages = {
    'db': { name: '@acme/db', dependencies: deps('@prisma/client') },
    'web': { name: '@acme/web' },
    'docs': { name: '@acme/docs' },
  }

  it('counts as a dependency by a scoped name, however the file imports it', async () => {
    const forms = [
      "import { prisma } from '@acme/db'",
      "import type { User } from '@acme/db/client'",
      "export * from '@acme/db'",
      "export { prisma } from '@acme/db'",
      "const { prisma } = require('@acme/db')",
      "export const load = async () => (await import('@acme/db')).prisma",
    ]
    for (const code of forms) {
      rmSync(dir, { recursive: true, force: true })
      const project = await contextOf(packages, { 'web/lib/db.ts': code, 'docs/index.ts': 'export const title = 1' })

      expect(frameworks(project, 'web/app/page.tsx'), code).toEqual(['prisma'])
      expect(frameworks(project, 'docs/index.ts'), code).toEqual([])
    }
  })

  it('counts for the package the importing file is in, and the ones below it', async () => {
    const project = await contextOf(
      { ...packages, 'web/e2e': { name: 'web-e2e' } },
      { 'web/lib/db.ts': "import { prisma } from '@acme/db'" },
    )

    expect(frameworks(project, 'web/e2e/login.spec.ts')).toEqual(['prisma'])
    expect(frameworks(project, 'scripts/release.ts')).toEqual([])
  })

  // `server`, `app` and `utils` are what folders and path aliases are called too
  it("isn't followed by an unscoped name", async () => {
    const project = await contextOf(
      {
        'server': { name: 'server', dependencies: deps('sequelize') },
        'client': { name: 'client' },
        'ui': { name: '@acme/ui', dependencies: deps('lodash') },
      },
      { 'client/src/api.ts': "import type { Routes } from 'server/routes'\nimport helpers from 'server'\nimport { Button } from '@acme/ui'" },
    )

    // The scoped import in the same file is followed, the two unscoped ones aren't
    expect(frameworks(project, 'client/src/api.ts')).toEqual(['lodash'])
    expect(frameworks(project, 'server/models/user.js')).toEqual(['sequelize'])
  })

  it("isn't followed out of a string or a comment, or by a path alias", async () => {
    const project = await contextOf(packages, {
      'docs/guide.ts': "// import { prisma } from '@acme/db'\nexport const sample = \"import { prisma } from '@acme/db'\"",
      'docs/alias.ts': "import { cn } from '@/lib/utils'\nimport Button from '@components/Button'",
    })

    expect(frameworks(project, 'docs/guide.ts')).toEqual([])
  })

  it("brings what the imported package declares, not what's above it", async () => {
    const project = await contextOf(
      {
        'tests/fixtures': { name: 'fixtures', dependencies: deps('mongoose') },
        'tests/fixtures/ui': { name: '@acme/ui', dependencies: deps('lodash') },
        'app': { name: 'app' },
      },
      { 'app/page.tsx': "import { Button } from '@acme/ui'" },
    )

    expect(frameworks(project, 'app/page.tsx')).toEqual(['lodash'])
  })
})

describe('package scopes — rate limiting', () => {
  const RATE_LIMIT_PROXY = `import { Ratelimit } from '@upstash/ratelimit'
export async function proxy(request) {
  const { success } = await ratelimit.limit(request.headers.get('x-forwarded-for') ?? 'anonymous')
}
`

  it("is a package's own when it comes from a dependency", async () => {
    const project = await contextOf({
      '': { name: 'app' },
      'examples/limited': { name: 'limited', dependencies: deps('@upstash/ratelimit') },
    })

    expect(project.hasRateLimiting).toBe(false)
    expect(packageOf(project, 'app/api/items/route.ts').hasRateLimiting).toBe(false)
    expect(packageOf(project, 'examples/limited/app/api/items/route.ts').hasRateLimiting).toBe(true)
  })

  it('reaches the packages below the one that declares it', async () => {
    const project = await contextOf({
      '': { name: 'app', dependencies: deps('express-rate-limit') },
      'services/api': { name: 'api' },
    })

    expect(project.hasRateLimiting).toBe(true)
    expect(packageOf(project, 'services/api/pages/api/items.ts').hasRateLimiting).toBe(true)
  })

  it('is everyone\'s when the root middleware does it, as before', async () => {
    const project = await contextOf({
      '': { name: 'app' },
      'proxy.ts': RATE_LIMIT_PROXY,
      'examples/demo': { name: 'demo' },
    })

    expect(project.hasRateLimiting).toBe(true)
    expect(packageOf(project, 'examples/demo/app/api/items/route.ts').hasRateLimiting).toBe(true)
  })
})

describe('packageOf', () => {
  it("gives a hand-built context's own frameworks", () => {
    const project = makeProject({ detectedFrameworks: new Set(['prisma']), hasRateLimiting: true })

    expect(packageOf(project, 'apps/web/db.ts')).toEqual({ frameworks: new Set(['prisma']), hasRateLimiting: true })
  })

  it('finds the nearest package above a file', () => {
    const root = { frameworks: new Set<string>(), hasRateLimiting: false }
    const web = { frameworks: new Set(['prisma']), hasRateLimiting: true }
    const fixture = { frameworks: new Set(['mongoose']), hasRateLimiting: false }
    const project = makeProject({
      packageScopes: new Map([['', root], ['apps/web', web], ['apps/web/tests/fixture', fixture]]),
    })

    expect(packageOf(project, 'index.ts')).toBe(root)
    expect(packageOf(project, 'apps/readme.ts')).toBe(root)
    expect(packageOf(project, 'apps/web/package.json')).toBe(web)
    expect(packageOf(project, 'apps/web/src/db.ts')).toBe(web)
    expect(packageOf(project, 'apps/web/tests/fixture/src/db.ts')).toBe(fixture)
  })
})
