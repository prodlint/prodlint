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

// Next.js 16 renamed middleware.ts to proxy.ts: the same file, exporting `proxy` or a default
const CLERK = `import { clerkMiddleware } from '@clerk/nextjs/server'

export default clerkMiddleware()

export const config = {
  matcher: ['/((?!_next|favicon.ico).*)', '/(api|trpc)(.*)'],
}
`
const SUPABASE = `import { type NextRequest } from 'next/server'
import { updateSession } from '@/lib/supabase/proxy'

export async function proxy(request: NextRequest) {
  return await updateSession(request)
}
`
const I18N = `import { NextResponse, type NextRequest } from 'next/server'

export function proxy(request: NextRequest) {
  if (!request.nextUrl.pathname.startsWith('/en')) {
    return NextResponse.redirect(new URL('/en' + request.nextUrl.pathname, request.url))
  }
}
`
const RATE_LIMIT = `import { Ratelimit } from '@upstash/ratelimit'
import { Redis } from '@upstash/redis'
import { NextResponse, type NextRequest } from 'next/server'

const ratelimit = new Ratelimit({ redis: Redis.fromEnv(), limiter: Ratelimit.slidingWindow(10, '10 s') })

export async function proxy(request: NextRequest) {
  const { success } = await ratelimit.limit(request.headers.get('x-forwarded-for') ?? 'anonymous')
  return success ? NextResponse.next() : new NextResponse('Too many requests', { status: 429 })
}
`

// A fresh project per case, so one case's file can't answer for the next
async function contextOf(files: Record<string, string>) {
  rmSync(dir, { recursive: true, force: true })
  for (const [relPath, content] of Object.entries(files)) {
    mkdirSync(join(dir, relPath, '..'), { recursive: true })
    writeFileSync(join(dir, relPath), content)
  }
  return buildProjectContext(dir, [])
}

describe('buildProjectContext — middleware and proxy', () => {
  it('reads auth from middleware or a Next.js 16 proxy, at the root or in src/', async () => {
    for (const name of ['middleware.ts', 'src/middleware.js', 'proxy.ts', 'proxy.js', 'src/proxy.ts', 'src/proxy.js']) {
      expect((await contextOf({ [name]: CLERK })).hasAuthMiddleware, name).toBe(true)
    }
  })

  it('reads Supabase session handling from a proxy', async () => {
    expect((await contextOf({ 'src/proxy.ts': SUPABASE })).hasAuthMiddleware).toBe(true)
  })

  it("recognizes Auth.js's auth exported or called as the proxy or middleware", async () => {
    const files = {
      'proxy.ts': "export { auth as proxy } from '@/auth'\n",
      'middleware.ts': "export { auth as middleware } from '@/auth'\n",
      'src/middleware.ts': 'export { auth as default } from "./auth";\n\nexport const config = { matcher: ["/((?!api|_next/static).*)"] };\n',
      'proxy.js': "import { auth } from './auth'\n\nexport default auth((req) => {\n  if (!req.auth) return Response.redirect(new URL('/login', req.nextUrl.origin))\n})\n",
      // NextAuth v4
      'src/proxy.js': "export { default } from 'next-auth/middleware'\n",
    }
    for (const [name, content] of Object.entries(files)) {
      expect((await contextOf({ [name]: content })).hasAuthMiddleware, content).toBe(true)
    }
  })

  it("doesn't count a proxy that does no auth", async () => {
    expect((await contextOf({ 'proxy.ts': I18N })).hasAuthMiddleware).toBe(false)
  })

  it('reads rate limiting from a proxy', async () => {
    const project = await contextOf({ 'proxy.ts': RATE_LIMIT })
    expect(project.hasRateLimiting).toBe(true)
    expect(project.hasAuthMiddleware).toBe(false)
  })

  it('reads auth and rate limiting from the same proxy', async () => {
    const project = await contextOf({
      'src/proxy.ts': `import { clerkMiddleware } from '@clerk/nextjs/server'
import { Ratelimit } from '@upstash/ratelimit'
import { Redis } from '@upstash/redis'

const ratelimit = new Ratelimit({ redis: Redis.fromEnv(), limiter: Ratelimit.slidingWindow(10, '10 s') })

export default clerkMiddleware(async (auth, req) => {
  const { success } = await ratelimit.limit(req.headers.get('x-forwarded-for') ?? 'anonymous')
  if (!success) return new Response('Too many requests', { status: 429 })
})
`,
    })
    expect(project.hasAuthMiddleware).toBe(true)
    expect(project.hasRateLimiting).toBe(true)
  })

  // Next.js only runs a proxy at the app root or in src/. A helper module named proxy.ts
  // (Supabase's lib/supabase/proxy.ts) isn't one, and in a monorepo an app's proxy covers
  // that app alone, so it can't vouch for the rest of the repo.
  it('only reads the proxy and middleware of the scanned root', async () => {
    const project = await contextOf({
      'lib/supabase/proxy.ts': 'export async function updateSession(request) {\n  const { data } = await supabase.auth.getUser()\n}\n',
      'apps/web/proxy.ts': CLERK,
      'apps/admin/src/middleware.ts': CLERK,
    })
    expect(project.hasAuthMiddleware).toBe(false)
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
  const OFF_API = "\nexport const config = {\n  matcher: ['/((?!api|_next/static|_next/image|favicon.ico).*)'],\n}\n"

  const withConfig = (config: string) => contextOf({ 'middleware.ts': `${AUTHJS}\n${config}\n` })
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
    const project = await contextOf({ 'src/middleware.ts': `${AUTHJS}\nexport const config = { matcher: ${matcher} }\n` })
    expect(project.authMiddlewareExcludesApi).toBe(true)
  })

  it("reads a Next.js 16 proxy's matcher, and Next.js's examples/auth", async () => {
    for (const [name, content] of Object.entries({
      'proxy.ts': `export { auth as proxy } from '@/auth'\n${OFF_API}`,
      'src/proxy.ts': `import { clerkMiddleware } from '@clerk/nextjs/server'\n\nexport default clerkMiddleware()\n${OFF_API}`,
      // next-js examples/auth/middleware.ts
      'middleware.ts': 'export { auth as default } from "./auth";\n\n// Optionally, don\'t invoke Middleware on some paths\nexport const config = {\n  matcher: ["/((?!api|_next/static|_next/image|favicon.ico).*)"],\n};\n',
    })) {
      const project = await contextOf({ [name]: content })
      expect(project.hasAuthMiddleware, name).toBe(true)
      expect(project.authMiddlewareExcludesApi, name).toBe(true)
    }
    // Clerk's own matcher reaches /api
    expect((await contextOf({ 'proxy.ts': CLERK })).authMiddlewareExcludesApi).toBe(false)
  })

  // Next.js runs only one of these files, the one beside app/ or pages/. prodlint doesn't
  // work out which, so a matcher counts only when every file that does auth keeps off /api.
  it('needs every middleware file that does auth to keep off /api', async () => {
    const offApi = `${AUTHJS}${OFF_API}`
    for (const [files, excludes] of [
      [{ 'middleware.ts': offApi, 'src/middleware.ts': CLERK }, false],
      [{ 'middleware.ts': CLERK, 'src/proxy.ts': offApi }, false],
      [{ 'middleware.ts': offApi, 'proxy.ts': offApi }, true],
      // a proxy that does no auth doesn't count
      [{ 'middleware.ts': offApi, 'src/proxy.ts': I18N }, true],
    ] as const) {
      const project = await contextOf(files)
      expect(project.hasAuthMiddleware, Object.keys(files).join(' + ')).toBe(true)
      expect(project.authMiddlewareExcludesApi, Object.keys(files).join(' + ')).toBe(excludes)
    }
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
    const project = await contextOf({ 'middleware.ts': i18n })
    expect(project.hasAuthMiddleware).toBe(false)
    expect(project.authMiddlewareExcludesApi).toBe(false)
  })
})

// A server action is posted to the page that calls it, never to /api, so middleware whose
// matcher reaches only /api doesn't run on it
describe('buildProjectContext — an auth middleware matcher that reaches only /api', () => {
  // Auth.js as middleware.ts (its edge compatibility guide) and as a Next.js 16 proxy.ts
  const AUTH = {
    'middleware.ts': "import NextAuth from 'next-auth'\nimport authConfig from './auth.config'\n\nexport const { auth: middleware } = NextAuth(authConfig)\n",
    'proxy.ts': "export { auth as proxy } from '@/auth'\n",
  }
  const withMatcher = (matcher: string) => `export const config = {\n  matcher: ${matcher},\n}`

  // The flag for a middleware.ts and for a proxy.ts, each with `config` after the auth
  async function flags(config: string) {
    const flags: (boolean | undefined)[] = []
    for (const [name, auth] of Object.entries(AUTH)) {
      const project = await contextOf({ [name]: `${auth}\n${config}\n` })
      expect(project.hasAuthMiddleware, `${name}: ${config}`).toBe(true)
      flags.push(project.authMiddlewareExcludesPages)
    }
    return flags
  }

  it('notes a matcher that reaches only /api', async () => {
    for (const matcher of [
      "['/api/:path*']",
      "'/api/:path*'",
      "'/api/(.*)'",
      "['/api', '/api/:path+']",
      "['/api/admin/:path*', '/api/billing/:path*']",
      // every API route but Auth.js's own
      "['/api/((?!auth).*)']",
      // the object form, and a template literal
      "[{ source: '/api/:path*', has: [{ type: 'header', key: 'authorization' }] }]",
      '[`/api/:path*`]',
    ]) {
      expect(await flags(withMatcher(matcher)), matcher).toEqual([true, true])
    }
  })

  it("doesn't when the matcher can reach a page", async () => {
    for (const matcher of [
      // Auth.js's docs and Next.js's examples/auth: every path but /api
      "['/((?!api|_next/static|_next/image|favicon.ico).*)']",
      // Clerk's: pages, and /api through /(api|trpc)(.*)
      String.raw`['/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)', '/(api|trpc)(.*)']`,
      "['/api/:path*', '/dashboard/:path*']",
      // /trpc/x, /apikeys and /api.json aren't under /api
      "['/api/:path*', '/trpc/:path*']",
      "'/(api|trpc)(.*)'",
      "'/api(.*)'",
      "'/apikeys/:path*'",
      "'/api/:id?.json'",
      "'/:path*'",
      "'/(.*)'",
      "'/'",
    ]) {
      expect(await flags(withMatcher(matcher)), matcher).toEqual([false, false])
    }
  })

  // Middleware with no matcher runs on every path. One that can't be read keeps today's rating.
  it("doesn't when there's no matcher, or it can't be read", async () => {
    for (const config of [
      '',
      "export const config = { runtime: 'nodejs' }",
      "// export const config = { matcher: ['/api/:path*'] }",
      // Next.js reads only an exported const, and only literals in it
      "const config = { matcher: ['/api/:path*'] }\nexport { config }",
      "const API_ROUTES = ['/api/:path*']\nexport const config = { matcher: API_ROUTES }",
      "export const config = { matcher: [...API_ROUTES, '/api/admin/:path*'] }",
      'export const config = { matcher: [`/${API}/:path*`] }',
      // sources Next.js rejects
      "export const config = { matcher: ['/api/((?!auth).*'] }",
      "export const config = { matcher: ['api/:path*'] }",
    ]) {
      expect(await flags(config), config).toEqual([false, false])
    }
  })

  // As with /api, every file that does auth must agree
  it('needs every middleware file that does auth to reach only /api', async () => {
    const apiOnly = (name: keyof typeof AUTH) => `${AUTH[name]}\n${withMatcher("['/api/:path*']")}\n`
    for (const [files, excludes] of [
      [{ 'middleware.ts': apiOnly('middleware.ts'), 'src/proxy.ts': CLERK }, false],
      [{ 'middleware.ts': CLERK, 'proxy.ts': apiOnly('proxy.ts') }, false],
      [{ 'middleware.ts': apiOnly('middleware.ts'), 'proxy.ts': apiOnly('proxy.ts') }, true],
      // a proxy that does no auth doesn't count
      [{ 'middleware.ts': apiOnly('middleware.ts'), 'src/proxy.ts': I18N }, true],
    ] as const) {
      const project = await contextOf(files)
      expect(project.hasAuthMiddleware, Object.keys(files).join(' + ')).toBe(true)
      expect(project.authMiddlewareExcludesPages, Object.keys(files).join(' + ')).toBe(excludes)
    }
  })

  it('reads the matcher only of middleware that does auth', async () => {
    const project = await contextOf({ 'proxy.ts': `${RATE_LIMIT}\n${withMatcher("['/api/:path*']")}\n` })
    expect(project.hasRateLimiting).toBe(true)
    expect(project.hasAuthMiddleware).toBe(false)
    expect(project.authMiddlewareExcludesPages).toBe(false)
  })
})
