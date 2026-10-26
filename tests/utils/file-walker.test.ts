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
