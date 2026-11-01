import { describe, it, expect } from 'vitest'
import { serverActionAuthRule } from '../../src/rules/server-action-auth.js'
import { makeFile, makeProject, scanFiles } from '../helpers.js'

const project = makeProject()

describe('server-action-auth rule', () => {
  it('detects server action with mutation but no auth', () => {
    const file = makeFile(`'use server'
export async function deleteItem(id) {
  await db.delete(items).where({ id })
}`)
    const findings = serverActionAuthRule.check(file, project)
    expect(findings).toHaveLength(1)
    expect(findings[0].ruleId).toBe('server-action-auth')
    expect(findings[0].severity).toBe('warning')
    expect(findings[0].message).toContain('anyone can call this action')
  })

  it('allows server action with auth check', () => {
    const file = makeFile(`'use server'
export async function deleteItem(id) {
  const session = await auth()
  if (!session) throw new Error('Unauthorized')
  await db.delete(items).where({ id })
}`)
    const findings = serverActionAuthRule.check(file, project)
    expect(findings).toHaveLength(0)
  })

  it('allows server action with getServerSession', () => {
    const file = makeFile(`'use server'
export async function updateItem(id, data) {
  const session = await getServerSession()
  await db.update(data)
}`)
    const findings = serverActionAuthRule.check(file, project)
    expect(findings).toHaveLength(0)
  })

  it('ignores non-server-action files', () => {
    const file = makeFile(`export async function deleteItem(id) {
  await db.delete(items).where({ id })
}`)
    const findings = serverActionAuthRule.check(file, project)
    expect(findings).toHaveLength(0)
  })

  it('ignores read-only server actions', () => {
    const file = makeFile(`'use server'
export async function getItems() {
  return await db.query('SELECT * FROM items')
}`)
    const findings = serverActionAuthRule.check(file, project)
    expect(findings).toHaveLength(0)
  })

  // Next.js's auth guide: middleware/proxy shouldn't be the only line of defense, and server
  // actions should be treated like public API endpoints that check the user themselves
  it('still reports, at info, when auth middleware exists', () => {
    const proj = makeProject({ hasAuthMiddleware: true })
    const file = makeFile(`'use server'
export async function deleteItem(id) {
  await db.delete(items).where({ id })
}`)
    const findings = serverActionAuthRule.check(file, proj)
    expect(findings).toHaveLength(1)
    expect(findings[0].severity).toBe('info')
    expect(findings[0].line).toBe(1)
    expect(findings[0].message).toContain('middleware auth detected')
    expect(findings[0].message).not.toContain('anyone can call this action')
    expect(findings[0].fix).toContain('in the action')
  })

  it('with auth middleware, still skips actions that check auth, read-only actions and public actions', () => {
    const proj = makeProject({ hasAuthMiddleware: true })
    const files = [
      makeFile(`'use server'
export async function deleteItem(id) {
  const session = await auth()
  if (!session) throw new Error('Unauthorized')
  await db.delete(items).where({ id })
}`),
      makeFile(`'use server'
export async function getItems() {
  return await db.query('SELECT * FROM items')
}`),
      makeFile(`'use server'
export async function submitFeedback(data) {
  await db.insert(feedback).values(data)
}`, { relativePath: 'actions/feedback.ts' }),
    ]
    for (const file of files) {
      expect(serverActionAuthRule.check(file, proj), file.content).toHaveLength(0)
    }
  })

  // Through the scanner: clerkMiddleware() makes no route private until it's told to,
  // so detecting it says nothing about the pages an action is posted to
  it('reports at info when the root middleware.ts uses an auth library', async () => {
    const action = { 'app/actions/items.ts': "'use server'\nexport async function deleteItem(id) {\n  await db.delete(items).where({ id })\n}\n" }
    const findings = async (files: Record<string, string>) =>
      (await scanFiles(files)).findings.filter(f => f.ruleId === 'server-action-auth')

    expect((await findings(action)).map(f => f.severity)).toEqual(['warning'])
    const middleware = "import { clerkMiddleware } from '@clerk/nextjs/server'\nexport default clerkMiddleware()\n"
    expect((await findings({ ...action, 'middleware.ts': middleware })).map(f => f.severity)).toEqual(['info'])
  })

  // Through the scanner: Next.js 16 renamed middleware.ts to proxy.ts
  it('reports at info when a Next.js 16 proxy does the auth', async () => {
    const action = { 'app/actions/items.ts': "'use server'\nexport async function deleteItem(id) {\n  await db.delete(items).where({ id })\n}\n" }
    const findings = async (files: Record<string, string>) =>
      (await scanFiles(files)).findings.filter(f => f.ruleId === 'server-action-auth')

    expect((await findings(action)).map(f => f.severity)).toEqual(['warning'])
    expect((await findings({ ...action, 'proxy.ts': "export { auth as proxy } from '@/auth'\n" })).map(f => f.severity)).toEqual(['info'])
  })

  // An action is posted to the page that calls it, never to /api, so middleware whose
  // matcher reaches only /api doesn't run on it
  it("keeps the warning when the auth middleware's matcher doesn't cover pages", () => {
    const proj = makeProject({ hasAuthMiddleware: true, authMiddlewareExcludesPages: true })
    const file = makeFile(`'use server'
export async function deleteItem(id) {
  await db.delete(items).where({ id })
}`)
    const findings = serverActionAuthRule.check(file, proj)
    expect(findings).toHaveLength(1)
    expect(findings[0].severity).toBe('warning')
    expect(findings[0].line).toBe(1)
    expect(findings[0].message).toBe("Server action performs mutations without any authentication check (middleware auth detected, but its matcher doesn't cover pages)")
    expect(findings[0].fix).toContain('Add auth check')
  })

  // Through the scanner, with the matcher in a middleware.ts and in a Next.js 16 proxy.ts
  it("rates actions by the auth middleware's matcher", async () => {
    const action = { 'app/actions/items.ts': "'use server'\nexport async function deleteItem(id) {\n  await db.delete(items).where({ id })\n}\n" }
    const severities = async (files: Record<string, string>) =>
      (await scanFiles(files)).findings.filter(f => f.ruleId === 'server-action-auth').map(f => f.severity)
    const auth = {
      'middleware.ts': "import NextAuth from 'next-auth'\nimport authConfig from './auth.config'\n\nexport const { auth: middleware } = NextAuth(authConfig)\n",
      'proxy.ts': "export { auth as proxy } from '@/auth'\n",
    }

    for (const [name, content] of Object.entries(auth)) {
      for (const [config, severity] of [
        ["export const config = { matcher: ['/api/:path*'] }", 'warning'],
        ['', 'info'],
        // Auth.js's documented matcher: every path but /api
        ["export const config = { matcher: ['/((?!api|_next/static|_next/image|favicon.ico).*)'] }", 'info'],
        // Clerk's: pages, and /api through /(api|trpc)(.*)
        [String.raw`export const config = { matcher: ['/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)', '/(api|trpc)(.*)'] }`, 'info'],
        // a matcher that isn't a literal
        ["const API_ROUTES = ['/api/:path*']\nexport const config = { matcher: API_ROUTES }", 'info'],
      ]) {
        expect(await severities({ ...action, [name]: `${content}\n${config}\n` }), `${name}: ${config}`).toEqual([severity])
      }
    }
  })

  it('does not count a sessionId variable as an auth check', () => {
    const file = makeFile(`'use server'
export async function saveCart(formData: FormData) {
  const sessionId = formData.get('sessionId')
  await db.insert(carts).values({ sessionId, items: JSON.parse(String(formData.get('items'))) })
}`, { relativePath: 'app/actions/cart.ts' })
    const findings = serverActionAuthRule.check(file, project)
    expect(findings).toHaveLength(1)
  })

  it('still counts session lookups and session guards', () => {
    const checks = [
      'const session = await verifySession()',
      'const session = await getIronSession(await cookies(), sessionOptions)',
      'const { user } = await lucia.validateSession(id)',
      "const token = (await cookies()).get('session')?.value",
      'if (!session?.userId) redirect("/login")',
      'const userId = session.user.id',
    ]
    for (const check of checks) {
      const file = makeFile(`'use server'
export async function deleteItem(id) {
  ${check}
  await db.delete(items).where({ id })
}`)
      expect(serverActionAuthRule.check(file, project), check).toHaveLength(0)
    }
  })

  it('ignores "use server" in a string, which is not a directive', () => {
    const file = makeFile(`export function explain() {
  throw new Error('Expose it by marking it with "use server".')
}
export function remove(id) {
  return db.delete(items).where({ id })
}`, { relativePath: 'src/lib/items.ts' })
    const findings = serverActionAuthRule.check(file, project)
    expect(findings).toHaveLength(0)
  })

  it('skips public action patterns', () => {
    const file = makeFile(`'use server'
export async function submitFeedback(data) {
  await db.insert(feedback).values(data)
}`, { relativePath: 'actions/feedback.ts' })
    const findings = serverActionAuthRule.check(file, project)
    expect(findings).toHaveLength(0)
  })
})
