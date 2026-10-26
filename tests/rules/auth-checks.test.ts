import { describe, it, expect } from 'vitest'
import { authChecksRule } from '../../src/rules/auth-checks.js'
import { makeFile, makeProject, scanFiles } from '../helpers.js'

describe('auth-checks rule', () => {
  it('flags POST API route without auth as critical (mutation)', () => {
    const file = makeFile(
      `export async function POST() {\n  return Response.json({ ok: true })\n}`,
      { relativePath: 'app/api/users/route.ts' },
    )
    const project = makeProject()
    const findings = authChecksRule.check(file, project)
    expect(findings).toHaveLength(1)
    expect(findings[0].severity).toBe('critical')
  })

  it('flags DELETE API route without auth as critical (mutation)', () => {
    const file = makeFile(
      `export async function DELETE() {\n  return Response.json({ ok: true })\n}`,
      { relativePath: 'app/api/users/route.ts' },
    )
    const project = makeProject()
    const findings = authChecksRule.check(file, project)
    expect(findings).toHaveLength(1)
    expect(findings[0].severity).toBe('critical')
  })

  it('flags PUT API route without auth as critical (mutation)', () => {
    const file = makeFile(
      `export async function PUT() {\n  return Response.json({ ok: true })\n}`,
      { relativePath: 'app/api/users/route.ts' },
    )
    const project = makeProject()
    const findings = authChecksRule.check(file, project)
    expect(findings).toHaveLength(1)
    expect(findings[0].severity).toBe('critical')
  })

  it('flags GET API route without auth as info (read-only)', () => {
    const file = makeFile(
      `export async function GET() {\n  return Response.json({ ok: true })\n}`,
      { relativePath: 'app/api/users/route.ts' },
    )
    const project = makeProject()
    const findings = authChecksRule.check(file, project)
    expect(findings).toHaveLength(1)
    expect(findings[0].severity).toBe('info')
  })

  it('passes when getServerSession is used', () => {
    const file = makeFile(
      `import { getServerSession } from 'next-auth'\nexport async function GET() {\n  const session = await getServerSession()\n}`,
      { relativePath: 'app/api/users/route.ts' },
    )
    const findings = authChecksRule.check(file, makeProject())
    expect(findings).toHaveLength(0)
  })

  it('passes when auth() is used', () => {
    const file = makeFile(
      `export async function GET() {\n  const session = await auth()\n}`,
      { relativePath: 'app/api/users/route.ts' },
    )
    const findings = authChecksRule.check(file, makeProject())
    expect(findings).toHaveLength(0)
  })

  it('passes when getAuth() (Clerk) is used', () => {
    const file = makeFile(
      `export async function GET() {\n  const { userId } = getAuth(req)\n}`,
      { relativePath: 'app/api/users/route.ts' },
    )
    const findings = authChecksRule.check(file, makeProject())
    expect(findings).toHaveLength(0)
  })

  it('exempts auth routes', () => {
    const file = makeFile(
      `export async function POST() {}`,
      { relativePath: 'app/api/auth/login/route.ts' },
    )
    const findings = authChecksRule.check(file, makeProject())
    expect(findings).toHaveLength(0)
  })

  it('exempts webhook routes', () => {
    const file = makeFile(
      `export async function POST() {}`,
      { relativePath: 'app/api/webhook/route.ts' },
    )
    const findings = authChecksRule.check(file, makeProject())
    expect(findings).toHaveLength(0)
  })

  it('exempts health check routes', () => {
    const file = makeFile(
      `export async function GET() {}`,
      { relativePath: 'app/api/health/route.ts' },
    )
    const findings = authChecksRule.check(file, makeProject())
    expect(findings).toHaveLength(0)
  })

  it('exempts stripe routes', () => {
    const file = makeFile(
      `export async function POST() {}`,
      { relativePath: 'app/api/stripe/webhook/route.ts' },
    )
    const findings = authChecksRule.check(file, makeProject())
    expect(findings).toHaveLength(0)
  })

  it('downgrades to info when middleware auth detected', () => {
    const file = makeFile(
      `export async function POST() {\n  return Response.json({ ok: true })\n}`,
      { relativePath: 'app/api/users/route.ts' },
    )
    const project = makeProject({ hasAuthMiddleware: true })
    const findings = authChecksRule.check(file, project)
    expect(findings).toHaveLength(1)
    expect(findings[0].severity).toBe('info')
    expect(findings[0].message).toContain('middleware')
  })

  it('skips non-API files', () => {
    const file = makeFile(
      `export function Page() { return <div>Hello</div> }`,
      { relativePath: 'app/page.tsx' },
    )
    const findings = authChecksRule.check(file, makeProject())
    expect(findings).toHaveLength(0)
  })

  it('reports correct handler line', () => {
    const file = makeFile(
      `import { NextResponse } from 'next/server'\n\nexport async function GET() {\n  return NextResponse.json({})\n}`,
      { relativePath: 'app/api/data/route.ts' },
    )
    const findings = authChecksRule.check(file, makeProject())
    expect(findings[0].line).toBe(3)
  })

  it('works with Pages Router API routes', () => {
    const file = makeFile(
      `export default function handler(req, res) {\n  res.json({ ok: true })\n}`,
      { relativePath: 'pages/api/users.ts' },
    )
    const findings = authChecksRule.check(file, makeProject())
    expect(findings).toHaveLength(1)
  })

  it('does not count an upstream Authorization header as an auth check', () => {
    const file = makeFile([
      'export async function POST(req: Request) {',
      '  const body = await req.json()',
      "  const res = await fetch('https://api.openai.com/v1/chat/completions', {",
      "    method: 'POST',",
      '    headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },',
      '    body: JSON.stringify(body),',
      '  })',
      '  return Response.json(await res.json())',
      '}',
    ].join('\n'), { relativePath: 'app/api/chat/route.ts' })
    const findings = authChecksRule.check(file, makeProject())
    expect(findings).toHaveLength(1)
    expect(findings[0].severity).toBe('critical')
  })

  it('still counts reading the incoming Authorization header', () => {
    const appRouter = makeFile([
      'export async function POST(req: Request) {',
      "  const token = req.headers.get('Authorization')?.replace('Bearer ', '')",
      "  if (!token) return new Response('Unauthorized', { status: 401 })",
      '}',
    ].join('\n'), { relativePath: 'app/api/items/route.ts' })
    const nextHeaders = makeFile([
      'export async function DELETE() {',
      "  const auth = (await headers()).get('authorization')",
      '}',
    ].join('\n'), { relativePath: 'app/api/items/route.ts' })
    const pagesRouter = makeFile([
      'export default function handler(req, res) {',
      '  const token = req.headers.authorization',
      '}',
    ].join('\n'), { relativePath: 'pages/api/items.ts' })
    const project = makeProject()
    expect(authChecksRule.check(appRouter, project)).toHaveLength(0)
    expect(authChecksRule.check(nextHeaders, project)).toHaveLength(0)
    expect(authChecksRule.check(pagesRouter, project)).toHaveLength(0)
  })

  it('does not suppress auth check when bearer is in an error string', () => {
    const file = makeFile(
      `export async function POST() {\n  return Response.json({ error: "Missing bearer token" })\n}`,
      { relativePath: 'app/api/data/route.ts' },
    )
    const findings = authChecksRule.check(file, makeProject())
    expect(findings).toHaveLength(1)
  })
})

// Handlers wrapped in an auth helper, and handlers exported as consts, on both code paths
describe.each([
  { path: 'AST', withAst: true },
  { path: 'regex fallback', withAst: false },
])('auth-checks handler exports ($path)', ({ withAst }) => {
  const check = (lines: string[], relativePath = 'app/api/items/route.ts', project = makeProject()) =>
    authChecksRule.check(makeFile(lines.join('\n'), { relativePath, withAst }), project)

  it('passes handlers wrapped in a with* helper imported from the auth module', () => {
    // dub's withWorkspace and withAdmin live in @/lib/auth
    expect(check([
      "import { withWorkspace } from '@/lib/auth'",
      '',
      'export const GET = withWorkspace(async ({ workspace }) => {',
      '  return Response.json(workspace)',
      '})',
      '',
      'export const POST = withWorkspace(',
      '  async ({ req, workspace }) => Response.json(await createLink(workspace, await req.json())),',
      "  { requiredPermissions: ['links.write'] },",
      ')',
    ])).toHaveLength(0)
    expect(check([
      'import { withAdmin } from "@/lib/auth/admin";',
      'export const DELETE = withAdmin(async ({ params }) => Response.json(await ban(params.id)));',
    ])).toHaveLength(0)
  })

  it('passes handlers wrapped in a helper whose name says auth or session', () => {
    // NextAuth v5's auth(handler), Auth0's withApiAuthRequired, a local session helper
    expect(check([
      "import { auth } from '@/auth'",
      'export const POST = auth(async (req) => {',
      "  if (!req.auth) return Response.json({ error: 'Not signed in' }, { status: 401 })",
      '  return Response.json(await save(await req.json()))',
      '})',
    ])).toHaveLength(0)
    expect(check([
      "import { withApiAuthRequired } from '@auth0/nextjs-auth0'",
      'export default withApiAuthRequired(async function handler(req, res) {',
      '  res.json(await listItems())',
      '})',
    ], 'pages/api/items.ts')).toHaveLength(0)
    expect(check([
      "import { withUserSession } from '@/lib/api'",
      'export const DELETE = withUserSession(async ({ user }) => Response.json(await removeItem(user)))',
    ])).toHaveLength(0)
  })

  it('follows curried and nested wrappers', () => {
    expect(check([
      "import { withTeam } from '@/lib/auth/team'",
      "export const POST = withTeam({ role: 'owner' })(async ({ team }) => Response.json(await invite(team)))",
    ])).toHaveLength(0)
    expect(check([
      "import { withAxiom } from 'next-axiom'",
      "import { withWorkspace } from '@/lib/auth'",
      'export const POST = withAxiom(withWorkspace(async ({ req }) => Response.json(await save(req))))',
    ])).toHaveLength(0)
  })

  it('follows handlers bound to another name', () => {
    expect(check([
      "import { withWorkspace } from '@/lib/auth'",
      'export const PATCH = withWorkspace(async ({ req }) => Response.json(await update(req)))',
      'export const PUT = PATCH',
    ])).toHaveLength(0)
    expect(check([
      "import { withSession } from '@/lib/auth'",
      'const handler = withSession(async ({ req }) => Response.json(await save(req)))',
      'export { handler as GET, handler as POST }',
    ])).toHaveLength(0)
  })

  it('does not ask for auth on an OPTIONS (CORS preflight) handler', () => {
    expect(check([
      "import { withPublishableKey } from '@/lib/auth/publishable-key'",
      'export const OPTIONS = () => new Response(null, { status: 204, headers: CORS_HEADERS })',
      'export const POST = withPublishableKey(async ({ req }) => Response.json(await track(req)))',
    ])).toHaveLength(0)
  })

  it('still flags handlers whose wrapper is not an auth helper', () => {
    const wrappers = [
      ["import { withAxiom } from 'next-axiom'", 'withAxiom('],
      ["import { withErrorHandler } from '@/lib/api/errors'", 'withErrorHandler('],
      // calcom's withMiddleware runs API-key checks, but only its config in another file says so
      ["import { withMiddleware } from '~/lib/helpers/withMiddleware'", 'withMiddleware()('],
      // hands the handler a service-role client; it doesn't check that the caller is an admin
      ["import { withAdmin } from '@/lib/supabase/admin'", 'withAdmin('],
      ["import { withPostAuthor } from '@/lib/blog'", 'withPostAuthor('],
      ["import { withoutAuth } from '@/lib/auth'", 'withoutAuth('],
      ["import { withPublicAccess } from '@/lib/auth'", 'withPublicAccess('],
    ]
    for (const [importLine, call] of wrappers) {
      const findings = check([importLine, `export const POST = ${call}async (req) => Response.json(await save(req)))`])
      expect(findings, call).toHaveLength(1)
      expect(findings[0].severity, call).toBe('critical')
      expect(findings[0].line, call).toBe(2)
    }
  })

  it('flags the handler a wrapper does not cover', () => {
    const findings = check([
      "import { withWorkspace } from '@/lib/auth'",
      'export const GET = withWorkspace(async ({ workspace }) => Response.json(workspace))',
      '',
      'export async function POST(req: Request) {',
      '  return Response.json(await save(await req.json()))',
      '}',
    ])
    expect(findings).toHaveLength(1)
    expect(findings[0].severity).toBe('critical')
    expect(findings[0].line).toBe(4)
  })

  it('flags an export const POST arrow as critical, at its line', () => {
    const findings = check([
      "import { NextResponse } from 'next/server'",
      '',
      'export const POST = async (req: Request) => {',
      '  const body = await req.json()',
      '  return NextResponse.json(await db.item.create({ data: body }))',
      '}',
    ])
    expect(findings).toHaveLength(1)
    expect(findings[0].severity).toBe('critical')
    expect(findings[0].line).toBe(3)
  })

  it('treats PUT, PATCH and DELETE consts, typed or not, as mutations', () => {
    for (const handler of [
      'export const PUT = async () => Response.json({})',
      'export const PATCH = async function () { return Response.json({}) }',
      'export let DELETE = (req) => Response.json({})',
      'export const POST: RouteHandler = async () => Response.json({})',
      'export const DELETE = removeItem',
    ]) {
      const findings = check(['async function removeItem() { return Response.json({}) }', handler])
      expect(findings, handler).toHaveLength(1)
      expect(findings[0].severity, handler).toBe('critical')
      expect(findings[0].line, handler).toBe(2)
    }
  })

  it('reads a handler bound across lines and exported from a list', () => {
    const findings = check([
      'const execute = async (',
      '  req: Request,',
      ') => Response.json(await run(await req.json()))',
      '',
      'export {',
      '  execute as GET,',
      '  execute as POST,',
      '}',
    ])
    expect(findings).toHaveLength(1)
    expect(findings[0].severity).toBe('critical')
    expect(findings[0].line).toBe(6)
  })

  it('keeps a const mutation at info when its code is in another file', () => {
    // the auth check may be in the imported handler, which this file can't see
    for (const lines of [
      ["import { removeItem } from '@/lib/items'", 'export const DELETE = removeItem'],
      ["import { handler } from '@/lib/items'", 'export const POST = defaultResponder(handler)'],
      ["export { POST } from '../items/route'"],
    ]) {
      const findings = check(lines)
      expect(findings, lines.join('; ')).toHaveLength(1)
      expect(findings[0].severity, lines.join('; ')).toBe('info')
    }
  })

  it('keeps a tRPC route at info: the router checks auth per procedure', () => {
    // create-t3-app's src/app/api/trpc/[trpc]/route.ts, and the same handler as a function
    const t3 = check([
      "import { fetchRequestHandler } from '@trpc/server/adapters/fetch'",
      "import { appRouter } from '~/server/api/root'",
      '',
      'const handler = (req: Request) =>',
      "  fetchRequestHandler({ endpoint: '/api/trpc', req, router: appRouter, createContext: () => ({}) })",
      '',
      'export { handler as GET, handler as POST }',
    ], 'src/app/api/trpc/[trpc]/route.ts')
    const fn = check([
      "import { fetchRequestHandler } from '@trpc/server/adapters/fetch'",
      'export async function POST(req: Request) {',
      "  return fetchRequestHandler({ endpoint: '/api/trpc', req, router: appRouter, createContext: () => ({}) })",
      '}',
    ], 'app/api/trpc/[trpc]/route.ts')
    for (const findings of [t3, fn]) {
      expect(findings).toHaveLength(1)
      expect(findings[0].severity).toBe('info')
    }
  })

  it('keeps const GET handlers at info, at their line', () => {
    const findings = check(["import { db } from '@/lib/db'", 'export const GET = async () => Response.json(await db.item.findMany())'])
    expect(findings).toHaveLength(1)
    expect(findings[0].severity).toBe('info')
    expect(findings[0].line).toBe(2)
  })

  it('keeps const mutations at info when middleware auth is detected', () => {
    const findings = check(['export const POST = async () => Response.json({})'], 'app/api/items/route.ts', makeProject({ hasAuthMiddleware: true }))
    expect(findings).toHaveLength(1)
    expect(findings[0].severity).toBe('info')
  })

  it("reports a Pages Router handler at its default export's line", () => {
    const findings = check([
      "import type { NextApiRequest, NextApiResponse } from 'next'",
      '',
      'export default async function handler(req: NextApiRequest, res: NextApiResponse) {',
      '  res.json(await listItems())',
      '}',
    ], 'pages/api/items.ts')
    expect(findings).toHaveLength(1)
    expect(findings[0].severity).toBe('info')
    expect(findings[0].line).toBe(3)
  })
})

// Middleware whose config.matcher leaves out /api doesn't run on API routes, so it can't
// vouch for them
describe('auth-checks when the auth middleware matcher excludes /api', () => {
  const project = makeProject({ hasAuthMiddleware: true, authMiddlewareExcludesApi: true })
  const POST = 'export async function POST() {\n  return Response.json({ ok: true })\n}'
  const check = (relativePath: string, code = POST) => authChecksRule.check(makeFile(code, { relativePath }), project)

  it('rates API routes as it would with no middleware', () => {
    for (const path of ['app/api/items/route.ts', 'src/app/api/items/route.ts', 'app/(admin)/api/items/route.ts', 'app/api/(v1)/items/route.ts']) {
      const findings = check(path)
      expect(findings, path).toHaveLength(1)
      expect(findings[0].severity, path).toBe('critical')
      expect(findings[0].message, path).toBe('API route has no authentication check (middleware auth detected, but its matcher excludes /api)')
    }
    const get = check('app/api/items/route.ts', 'export async function GET() {\n  return Response.json([])\n}')
    expect(get).toHaveLength(1)
    expect(get[0].severity).toBe('info')
    const pages = check('pages/api/items.ts', 'export default function handler(req, res) {\n  res.json({ ok: true })\n}')
    expect(pages).toHaveLength(1)
    expect(pages[0].message).toContain('its matcher excludes /api')
  })

  it('still downgrades route handlers the middleware may run on', () => {
    // served at /dashboard/export and /en/api/items, which a matcher excluding /api reaches,
    // and at /api itself, which dub's /((?!api/|_next/).*) still matches
    for (const path of ['app/dashboard/export/route.ts', 'app/[locale]/api/items/route.ts', 'app/api/route.ts', 'pages/api/index.ts']) {
      const findings = check(path)
      expect(findings, path).toHaveLength(1)
      expect(findings[0].severity, path).toBe('info')
      expect(findings[0].message, path).toContain('middleware auth detected — verify coverage')
    }
  })

  // Through the scanner: Auth.js's docs leave /api out of the middleware with this matcher
  it("reads the matcher from the project's middleware", async () => {
    const route = { 'app/api/items/route.ts': `${POST}\n` }
    const middleware = "import NextAuth from 'next-auth'\nimport authConfig from './auth.config'\n\nexport const { auth: middleware } = NextAuth(authConfig)\n"
    const config = "\nexport const config = {\n  matcher: ['/((?!api|_next/static|_next/image|favicon.ico).*)'],\n}\n"
    const severities = async (files: Record<string, string>) =>
      (await scanFiles(files)).findings.filter(f => f.ruleId === 'auth-checks').map(f => f.severity)

    expect(await severities(route)).toEqual(['critical'])
    expect(await severities({ ...route, 'middleware.ts': middleware })).toEqual(['info'])
    expect(await severities({ ...route, 'middleware.ts': middleware + config })).toEqual(['critical'])
  })
})
