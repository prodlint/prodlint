import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { buildProjectContext, readFileContext } from '../../src/utils/file-walker.js'

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

describe('readFileContext — extensions', () => {
  // extname() sees no extension in `.env` and `local` in `.env.local`, which no rule listed
  it("gives every dotenv file the ext 'env'", async () => {
    for (const name of ['.env', '.env.local', '.env.production', 'apps/web/.env.example']) {
      mkdirSync(join(dir, name, '..'), { recursive: true })
      writeFileSync(join(dir, name), 'NEXT_PUBLIC_API_URL=/api\n')
      expect((await readFileContext(dir, name))?.ext, name).toBe('env')
    }
  })

  it('keeps the real extension of code files whose names start with .env', async () => {
    writeFileSync(join(dir, '.env.example.ts'), 'export {}\n')
    expect((await readFileContext(dir, '.env.example.ts'))?.ext).toBe('ts')
  })
})

// Next.js runs middleware only on the paths its config.matcher matches
describe('buildProjectContext — the auth middleware matcher', () => {
  // Auth.js's middleware, from its edge compatibility guide
  const AUTHJS = "import NextAuth from 'next-auth'\nimport authConfig from './auth.config'\n\nexport const { auth: middleware } = NextAuth(authConfig)\n"

  // A fresh project per case, so one case's middleware can't answer for the next
  async function contextWith(files: Record<string, string>) {
    rmSync(dir, { recursive: true, force: true })
    for (const [relPath, content] of Object.entries(files)) {
      mkdirSync(join(dir, relPath, '..'), { recursive: true })
      writeFileSync(join(dir, relPath), content)
    }
    return buildProjectContext(dir, [])
  }
  const withConfig = (config: string) => contextWith({ 'middleware.ts': `${AUTHJS}\n${config}\n` })
  const withMatcher = (matcher: string) => withConfig(`export const config = {\n  matcher: ${matcher},\n}`)

  it('notes a matcher that keeps the middleware off /api', async () => {
    for (const matcher of [
      // Auth.js's docs and Next.js's examples/auth
      "['/((?!api|_next/static|_next/image|favicon.ico).*)']",
      // dub's apps/web/middleware.ts
      "['/((?!api/|_next/|_proxy/|favicon.ico|sitemap.xml|robots.txt|manifest.webmanifest).*)']",
      // next-intl's
      String.raw`'/((?!api|_next|_vercel|.*\\..*).*)'`,
      // only the pages it guards
      "['/dashboard/:path*', '/settings/:path*']",
      "['/dashboard/:path*', '/settings/api-keys']",
      "'/dashboard/:path*'",
      "['/', '/account/:path*']",
      // the object form, and a template literal
      "[{ source: '/((?!api|_next/static|_next/image|favicon.ico).*)', missing: [{ type: 'header', key: 'next-router-prefetch' }] }]",
      '[`/((?!api|_next/static|_next/image|favicon.ico).*)`]',
    ]) {
      const project = await withMatcher(matcher)
      expect(project.hasAuthMiddleware, matcher).toBe(true)
      expect(project.authMiddlewareExcludesApi, matcher).toBe(true)
    }
  })

  it('reads a typed config, and middleware in src/', async () => {
    const matcher = "['/((?!api|_next/static|_next/image|favicon.ico).*)']"
    for (const config of [
      `export const config: MiddlewareConfig = { matcher: ${matcher} }`,
      `export const config = { matcher: ${matcher} } satisfies MiddlewareConfig`,
    ]) {
      expect((await withConfig(config)).authMiddlewareExcludesApi, config).toBe(true)
    }
    const project = await contextWith({ 'src/middleware.ts': `${AUTHJS}\nexport const config = { matcher: ${matcher} }\n` })
    expect(project.authMiddlewareExcludesApi).toBe(true)
  })

  it("doesn't when the matcher reaches /api", async () => {
    for (const matcher of [
      // Clerk's
      String.raw`['/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)', '/(api|trpc)(.*)']`,
      // Supabase's
      String.raw`['/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)']`,
      "'/api/:path*'",
      "['/dashboard/:path*', '/api/:path*']",
      // part of /api: the routes it reaches are covered
      "['/dashboard/:path*', '/api/admin/:path*']",
      "['/(dashboard|api/admin)/:path*']",
      // cal.com's API proxy: /api/bookings/_get, but not /api/bookings
      "['/:path*/_get', '/:path*/_post']",
      // only Auth.js's own routes are left out
      "['/((?!api/auth|_next/static|_next/image|favicon.ico).*)']",
      "'/:path*'",
      "'/(.*)'",
    ]) {
      const project = await withMatcher(matcher)
      expect(project.hasAuthMiddleware, matcher).toBe(true)
      expect(project.authMiddlewareExcludesApi, matcher).toBe(false)
    }
  })

  // Middleware with no matcher runs on every path. When the matcher can't be read, it's
  // taken to as well, as before.
  it("doesn't when there's no matcher, or it can't be read", async () => {
    for (const config of [
      '',
      "// export const config = { matcher: ['/dashboard/:path*'] }",
      "export const config = { runtime: 'nodejs' }",
      // Next.js reads only an exported const
      "const config = { matcher: ['/dashboard/:path*'] }\nexport { config }",
      'export const config = { matcher: PROTECTED_PATHS }',
      "export const config = { matcher: [...PROTECTED_PATHS, '/settings/:path*'] }",
      'export const config = { matcher: [`/${BASE}/:path*`] }',
      'export const config = makeConfig()',
      // sources Next.js rejects
      "export const config = { matcher: ['/((?!api).*'] }",
      "export const config = { matcher: ['dashboard/:path*'] }",
    ]) {
      const project = await withConfig(config)
      expect(project.hasAuthMiddleware, config).toBe(true)
      expect(project.authMiddlewareExcludesApi, config).toBe(false)
    }
  })

  it('reads the matcher only of middleware that does auth', async () => {
    const i18n = "import createMiddleware from 'next-intl/middleware'\n\nexport default createMiddleware(routing)\n\nexport const config = { matcher: ['/((?!api|_next|_vercel).*)'] }\n"
    const project = await contextWith({ 'middleware.ts': i18n })
    expect(project.hasAuthMiddleware).toBe(false)
    expect(project.authMiddlewareExcludesApi).toBe(false)
  })
})
