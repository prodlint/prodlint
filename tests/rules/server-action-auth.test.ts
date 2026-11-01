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

// next-safe-action: the check runs in the client's .use() middleware, usually in another
// file, as in dub's lib/actions/safe-action.ts
describe('server-action-auth on actions built on a client', () => {
  const check = (code: string, proj = project) =>
    serverActionAuthRule.check(makeFile(code, { relativePath: 'app/actions/items.ts' }), proj)

  const MUTATE = 'async ({ parsedInput }) => { await prisma.item.delete({ where: { id: parsedInput.id } }) }'

  // An action with this file's imports (a line of them, or the client's own) and definitions
  const built = (client: string, setup = `import { ${client} } from '@/lib/safe-action'`) => `'use server'
${setup}
export const deleteItemAction = ${client}
  .inputSchema(schema)
  .action(${MUTATE})
`

  it('counts a client whose name has an auth or session word', () => {
    for (const client of [
      'authActionClient',
      'authUserActionClient',
      'authPartnerActionClient',
      'authOrganizationActionClient',
      'authenticatedAction',
      'authedActionClient',
      'authorizedActionClient',
      'authAction',
      'sessionActionClient',
      'actionWithSession',
    ]) {
      expect(check(built(client)), client).toHaveLength(0)
    }
  })

  it('counts a protected client, and one named for its signed-in user', () => {
    for (const client of ['protectedAction', 'protectedActionClient', 'protectedClient', 'protectedWithClinicActionClient', 'userActionClient', 'userAction']) {
      expect(check(built(client)), client).toHaveLength(0)
    }
  })

  it('counts a client named for its admins', () => {
    for (const client of [
      'adminActionClient',
      'AdminActionClient',
      'adminAction',
      'superAdminActionClient',
      'superadminActionClient',
      'superAdminAction',
      'platformAdminActionClient',
      'systemAdminAction',
    ]) {
      expect(check(built(client)), client).toHaveLength(0)
    }
    // A hand-written wrapper of the same name, called directly
    expect(check(`'use server'\nexport const a = adminAction(schema, ${MUTATE})\n`)).toHaveLength(0)
  })

  // As in auth-checks: withSupabaseAdmin hands out a service-role client, and "adminClient" is
  // what one is usually called. An admin action client has to say it's one.
  it('does not count "admin" outside an action client\'s own name', () => {
    for (const client of [
      'adminClient',
      'supabaseAdmin',
      'supabaseAdminClient',
      'organizationAdminClient',
      // A helper or an action, not a client
      'logAdminAction',
      'createAdminAction',
      'updateAdminAction',
      'parseSuperAdminAction',
      'adminActionLogger',
      // The opposite
      'nonAdminActionClient',
      'publicAdminAction',
      'optionalAdminActionClient',
    ]) {
      expect(check(built(client)), client).toHaveLength(1)
    }
    for (const value of [
      `withSupabaseAdmin(${MUTATE})`,
      `withAdminClient(${MUTATE})`,
      `withAdmin(${MUTATE})`,
      `logAdminAction(${MUTATE})`,
      `createAdminClient().action(${MUTATE})`,
      `getAdminClient().action(${MUTATE})`,
    ]) {
      expect(check(`'use server'\nexport const a = ${value}\n`), value).toHaveLength(1)
    }
    // A middleware's name doesn't say it either: it may only load that client
    expect(check(built('actionClient.use(adminMiddleware)', ''))).toHaveLength(1)
    expect(check(built('actionClient.use(withSupabaseAdmin)', ''))).toHaveLength(1)
  })

  it('still reports a plain actionClient', () => {
    const findings = check(built('actionClient'))
    expect(findings).toHaveLength(1)
    expect(findings[0].severity).toBe('warning')
    expect(findings[0].line).toBe(1)
    expect(findings[0].message).toContain('anyone can call this action')
  })

  it('still reports a client whose name says the opposite, or nothing about auth', () => {
    for (const client of [
      'publicActionClient',
      'publicAuthActionClient',
      'optionalAuthActionClient',
      'optionalUserActionClient',
      'authOptionalActionClient',
      'anonActionClient',
      'anonymousAction',
      'guestActionClient',
      'noAuthActionClient',
      'nonAuthAction',
      'skipAuthAction',
      'bypassAuthActionClient',
      'withoutAuthActionClient',
      'unauthenticatedActionClient',
      'unprotectedActionClient',
      'optionalProtectedAction',
      // "Author" isn't auth
      'authorActionClient',
      'authorsAction',
      // "user" says it only as the client's own name
      'updateUserAction',
      'usersActionClient',
      'superUserActionClient',
      'templateActionClient',
      'workspaceAction',
      'safeAction',
      'baseActionClient',
    ]) {
      expect(check(built(client)), client).toHaveLength(1)
    }
  })

  it('reads the whole builder chain', () => {
    // .schema() is the older spelling of .inputSchema(), .stateAction() is for useActionState
    expect(check(`'use server'
import { authActionClient } from './safe-action'
export const a = authActionClient
  .metadata({ name: 'a' })
  .schema(schema)
  .bindArgsSchemas([z.string()])
  .outputSchema(output)
  .stateAction(${MUTATE})
`)).toHaveLength(0)
    expect(check(`'use server'
import { actionClient } from './safe-action'
export const a = actionClient
  .metadata({ name: 'auth' })
  .schema(schema)
  .stateAction(${MUTATE})
`)).toHaveLength(1)
  })

  it('counts a builder or wrapper of another library by the same names', () => {
    for (const value of [
      // zsa
      `authedProcedure.createServerAction().input(schema).handler(${MUTATE})`,
      `protectedProcedure.createServerAction().handler(${MUTATE})`,
      // a wrapper called directly
      `protectedAction(schema, ${MUTATE})`,
      `authAction(${MUTATE})`,
      // a factory
      `createAuthActionClient().action(${MUTATE})`,
    ]) {
      expect(check(`'use server'\nexport const a = ${value}\n`), value).toHaveLength(0)
    }
    for (const value of [
      `createServerAction().input(schema).handler(${MUTATE})`,
      `publicProcedure.createServerAction().input(schema).handler(${MUTATE})`,
      `validated(schema, ${MUTATE})`,
      `updateUser(${MUTATE})`,
      `publicAction(${MUTATE})`,
      `createSafeActionClient().action(${MUTATE})`,
    ]) {
      expect(check(`'use server'\nexport const a = ${value}\n`), value).toHaveLength(1)
    }
  })

  it('reads a renamed import by the name it was exported under', () => {
    expect(check(built('client', "import { authActionClient as client } from './safe-action'"))).toHaveLength(0)
    expect(check(built('authActionClient', "import { actionClient as authActionClient } from './safe-action'"))).toHaveLength(1)
    // A default import has only the local name
    expect(check(built('authActionClient', "import authActionClient from './auth-client'"))).toHaveLength(0)
  })

  it('reads a client off a namespace import', () => {
    expect(check(built('safe.authActionClient', "import * as safe from './safe-action'"))).toHaveLength(0)
    expect(check(built('safe.actionClient', "import * as safe from './safe-action'"))).toHaveLength(1)
    expect(check(built('auth.client', "import * as auth from './auth'"))).toHaveLength(0)
    expect(check(built('auth.optional', "import * as auth from './auth'"))).toHaveLength(1)
  })

  it('counts an auth .use() in the action\'s own chain', () => {
    for (const client of [
      'actionClient.use(authMiddleware)',
      'actionClient.use(authMiddleware())',
      'actionClient.use(auth.required)',
      'actionClient.use(checkSessionMiddleware)',
      'actionClient.use(logger).use(authMiddleware)',
      'actionClient.use(authMiddleware).use(logger)',
      // It adds the check, whatever it's added to
      'publicActionClient.use(authMiddleware)',
      'createSafeActionClient().use(authMiddleware)',
    ]) {
      expect(check(built(client, '')), client).toHaveLength(0)
    }
  })

  // dub's send-otp and create-user-account: an action for people with no session, like sending a
  // sign-up code, has no user to check. The fix would lock out the only people who can call it.
  it('counts a .use() that turns signed-in users away, as public by design', () => {
    for (const client of [
      'actionClient.use(throwIfAuthenticated)',
      'actionClient.use(throwIfUserAuthenticated)',
      'actionClient.use(throwIfLoggedIn)',
      'actionClient.use(throwIfSignedIn)',
      'actionClient.use(redirectIfAuthenticated)',
      'actionClient.use(redirectIfLoggedIn)',
      'actionClient.use(redirectIfSignedIn)',
      'actionClient.use(throwIfAlreadyAuthenticated)',
      // However it's written
      'actionClient.use(throwIfAuthenticated())',
      "actionClient.use(redirectIfAuthenticated('/dashboard'))",
      'actionClient.use(guards.throwIfAuthenticated)',
      'actionClient.use(logger).use(throwIfAuthenticated).use(rateLimit)',
      'publicActionClient.use(throwIfAuthenticated)',
    ]) {
      expect(check(built(client, '')), client).toHaveLength(0)
    }
    expect(check(built('actionClient.use(guard)', "import { throwIfAuthenticated as guard } from './guards'"))).toHaveLength(0)
    // A renamed import keeps its real name
    expect(check(built('actionClient.use(throwIfAuthenticated)', "import { logger as throwIfAuthenticated } from './guards'"))).toHaveLength(1)
    // A name that says it's for guests agrees with the guard
    expect(check(built('guestClient', 'const guestClient = actionClient.use(throwIfAuthenticated)'))).toHaveLength(0)
    expect(check(built('publicClient', 'const publicClient = actionClient.use(throwIfAuthenticated)'))).toHaveLength(0)
  })

  it('goes by the whole name of such a guard', () => {
    for (const client of [
      // The opposite, in words that aren't a check we can read
      'actionClient.use(throwIfUnauthenticated)',
      // Something else
      'actionClient.use(throwIfAuthenticatedApiError)',
      'actionClient.use(throwIfLoggedInUserNotFound)',
      'actionClient.use(throwIfAuthenticatedWithoutPlan)',
      'actionClient.use(logIfAuthenticated)',
      'actionClient.use(allowIfAuthenticated)',
      'actionClient.use(skipIfAuthenticated)',
      // Says less: a session could be expired or missing
      'actionClient.use(redirectIfSession)',
      'actionClient.use(throwIfSession)',
      'actionClient.use(throwIfSessionExpired)',
      'actionClient.use(throwIfAuth)',
      // It runs on nothing in this chain
      'actionClient.inputSchema(throwIfAuthenticated)',
      'actionClient.action(throwIfAuthenticated)',
    ]) {
      expect(check(built(client, '')), client).toHaveLength(1)
    }
    // An unless-style guard does check, as before
    expect(check(built('actionClient.use(throwIfNotAuthenticated)', ''))).toHaveLength(0)
  })

  it('still reports a neighbor of an action that turns signed-in users away', () => {
    const guest = `export const a = actionClient.use(throwIfAuthenticated).action(${MUTATE})`
    expect(check(`'use server'\n${guest}\nexport async function b(id) { await db.update(items).set({ id }) }\n`)).toHaveLength(1)
    expect(check(`'use server'\n${guest}\nexport async function b() { return db.query.items.findMany() }\n`)).toHaveLength(0)
  })

  it('does not count a .use() that shows no check', () => {
    for (const client of [
      // This lets anyone in
      'actionClient.use(authIfPresent)',
      'actionClient.use(logger)',
      'actionClient.use(rateLimit({ max: 5 }))',
      'actionClient.use(optionalAuth)',
      'actionClient.use(publicAuthMiddleware)',
      'actionClient.use(logAuthor)',
      'actionClient.use(async ({ next }) => next())',
    ]) {
      expect(check(built(client, '')), client).toHaveLength(1)
    }
  })

  describe('defined in the same file', () => {
    it('counts a client built with an auth .use(), whatever its name', () => {
      expect(check(built('userActionClient', 'const userActionClient = actionClient.use(authMiddleware)'))).toHaveLength(0)
      expect(check(built('client', 'const client = createSafeActionClient().use(authMiddleware)'))).toHaveLength(0)
    })

    it('counts a client built on an auth client', () => {
      expect(check(built('workspaceClient', `import { authActionClient } from './safe-action'
const workspaceClient = authActionClient.use(loadWorkspace)`))).toHaveLength(0)
      expect(check(built('b', `import { authActionClient } from './safe-action'
const a = authActionClient
const b = a.metadata({ name: 'b' })`))).toHaveLength(0)
    })

    it('counts a name that says auth once the client has a .use() it can be about', () => {
      // The middleware's check isn't one AUTH_PATTERNS knows, or sits behind another name
      expect(check(built('authActionClient', `const authActionClient = createSafeActionClient().use(async ({ next }) => {
  const user = await requireCurrentUser()
  return next({ ctx: { user } })
})`))).toHaveLength(0)
      expect(check(built('protectedAction', 'const protectedAction = actionClient.use(guard)'))).toHaveLength(0)
      expect(check(built('userActionClient', 'const userActionClient = publicActionClient.use(userMiddleware)'))).toHaveLength(0)
      expect(check(built('adminActionClient', 'const adminActionClient = actionClient.use(adminMiddleware)'))).toHaveLength(0)
      expect(check(built('adminAction', `const adminAction = actionClient.use(async ({ next }) => {
  const user = await requireAdmin()
  return next({ ctx: { user } })
})`))).toHaveLength(0)
    })

    it('does not trust a name when the definition shows no middleware', () => {
      for (const setup of [
        'const authActionClient = createSafeActionClient()',
        'const authActionClient = createSafeActionClient({ handleServerError })',
        'const authActionClient = actionClient',
        'const base = createSafeActionClient()\nconst authActionClient = base.metadata({ name: "a" })',
      ]) {
        expect(check(built('authActionClient', setup)), setup).toHaveLength(1)
      }
      expect(check(built('userActionClient', 'const userActionClient = createSafeActionClient()'))).toHaveLength(1)
      expect(check(built('adminActionClient', 'const adminActionClient = createSafeActionClient()'))).toHaveLength(1)
    })

    it('does not count a client with no check, or a name that says the opposite', () => {
      for (const [client, setup] of [
        ['client', 'const client = actionClient.use(logger)'],
        ['client', 'const client = createSafeActionClient()'],
        ['optionalAuthClient', 'const optionalAuthClient = actionClient.use(authMiddleware)'],
        ['optionalUserActionClient', 'const optionalUserActionClient = actionClient.use(async ({ next }) => next())'],
        ['publicClient', 'const publicClient = actionClient.use(logger)'],
      ]) {
        expect(check(built(client, setup)), setup).toHaveLength(1)
      }
    })

    it('trusts the name of a wrapper function, as in another file', () => {
      expect(check(`'use server'
function protectedAction(fn) {
  return async (input) => {
    const user = await requireCurrentUser()
    return fn(input, user)
  }
}
export const deleteItem = protectedAction(${MUTATE})
`)).toHaveLength(0)
    })

    it('survives clients defined in terms of each other', () => {
      expect(check(built('a', 'const a = b\nconst b = a'))).toHaveLength(1)
    })
  })

  describe('in a file with other exports', () => {
    const authed = `export const a = authActionClient.inputSchema(schema).action(${MUTATE})`

    it('still reports a mutating action that is not built on an auth client', () => {
      for (const other of [
        'export async function b(id) { await db.update(items).set({ id }) }',
        // dub's ban-partner: a plain helper exported next to its action is an endpoint too
        'export const b = async (id) => { await db.update(items).set({ id }) }',
        'export const b = actionClient.action(async () => { await db.update(items).set({ id }) })',
        'export default async function b(id) { await db.update(items).set({ id }) }',
        'const b = actionClient.action(async () => { await db.update(items).set({ id }) })\nexport { b }',
      ]) {
        const findings = check(`'use server'\n${authed}\n${other}\n`)
        expect(findings, other).toHaveLength(1)
        expect(findings[0].line).toBe(1)
      }
    })

    it('does not count the checked action\'s mutation against a read-only one', () => {
      for (const other of [
        'export async function b() { return db.query.items.findMany() }',
        'export const b = actionClient.action(async () => db.query.items.findMany())',
      ]) {
        expect(check(`'use server'\n${authed}\n${other}\n`), other).toHaveLength(0)
      }
    })

    it('covers a helper that only checked actions can reach', () => {
      expect(check(`'use server'
async function remove(id) { await db.delete(items).where({ id }) }
export const a = authActionClient.action(({ parsedInput }) => remove(parsedInput.id))
export const b = protectedAction(({ parsedInput }) => remove(parsedInput.id))
`)).toHaveLength(0)
    })

    it('ignores type exports', () => {
      expect(check(`'use server'
export type Input = { id: string }
export interface Output { ok: boolean }
export type { Other } from './types'
${authed}
`)).toHaveLength(0)
    })

    it('still reports a helper that an unchecked export can reach', () => {
      const findings = check(`'use server'
async function remove(id) { await db.delete(items).where({ id }) }
export const a = authActionClient.action(({ parsedInput }) => remove(parsedInput.id))
export async function b(id) { return remove(id) }
`)
      expect(findings).toHaveLength(1)
    })

    // Its code is read in its own file, but it isn't known to be checked
    it('treats a re-export as an unchecked export with no code here', () => {
      for (const reexport of ["export { other } from './other'", "export * from './other'"]) {
        expect(check(`'use server'\n${authed}\n${reexport}\n`), reexport).toHaveLength(0)
        expect(check(`'use server'
async function remove(id) { await db.delete(items).where({ id }) }
export const a = authActionClient.action(({ parsedInput }) => remove(parsedInput.id))
${reexport}
`), reexport).toHaveLength(1)
      }
    })
  })

  describe('export forms', () => {
    it('reads each way of exporting an action', () => {
      for (const code of [
        `export default authActionClient.action(${MUTATE})`,
        `const a = authActionClient.action(${MUTATE})\nexport { a }`,
        `const a = authActionClient.action(${MUTATE})\nexport { a as deleteItem }`,
        `const a = authActionClient.action(${MUTATE})\nexport default a`,
        `const a = authActionClient.action(${MUTATE})\nconst b = a\nexport { b }`,
        `export const a = authActionClient.action(${MUTATE}) as Action`,
        `export const a = authActionClient.action(${MUTATE}) satisfies Action`,
        `export const a = (authActionClient.action(${MUTATE}))`,
        `export const a = authActionClient.action(${MUTATE}), b = authActionClient.action(${MUTATE})`,
      ]) {
        expect(check(`'use server'\n${code}\n`), code).toHaveLength(0)
      }
    })

    it('reports the same forms on a plain client', () => {
      for (const code of [
        `export default actionClient.action(${MUTATE})`,
        `const a = actionClient.action(${MUTATE})\nexport { a }`,
        `const a = actionClient.action(${MUTATE})\nexport default a`,
        `export const a = actionClient.action(${MUTATE}) satisfies Action`,
        `export const a = authActionClient.action(${MUTATE}), b = actionClient.action(${MUTATE})`,
      ]) {
        expect(check(`'use server'\n${code}\n`), code).toHaveLength(1)
      }
    })
  })

  it('does not count a client name anywhere else in the file', () => {
    for (const code of [
      // Imported, but this action doesn't use it
      `import { authActionClient } from './safe-action'\nexport async function a(id) { await db.delete(items).where({ id }) }`,
      // A comment, and a string
      `// built on authActionClient\nexport async function a(id) { await db.delete(items).where({ id }) }`,
      `export async function a(id) { await db.delete(items).where({ id, by: 'authActionClient' }) }`,
      // The action's own name
      `export const authDeleteAction = actionClient.action(${MUTATE})`,
      `const authDeleteAction = actionClient.action(${MUTATE})\nexport { authDeleteAction }`,
      `export const protectedDelete = async (id) => { await db.delete(items).where({ id }) }`,
      // Arguments of a plain client
      `export const a = actionClient.inputSchema(authSchema).action(${MUTATE})`,
      `export const a = actionClient.inputSchema(authSchema.extend({ id: z.string() })).action(${MUTATE})`,
      `export const a = actionClient.action(authHandler)\nasync function authHandler({ parsedInput }) { await db.delete(items).where(parsedInput) }`,
      // An unexported client doesn't guard an exported function
      `const authActionClient = actionClient.use(authMiddleware)\nexport async function a(id) { await db.delete(items).where({ id }) }`,
      // Called inside the action's body
      `export async function a(id) { const run = authActionClient.action(noop); await db.delete(items).where({ id }) }`,
    ]) {
      expect(check(`'use server'\n${code}\n`), code).toHaveLength(1)
    }
  })

  it('leaves a file that exports nothing to the text check', () => {
    expect(check(`'use server'
const a = authActionClient.action(${MUTATE})
`)).toHaveLength(1)
  })

  it('leaves a file Babel can\'t parse to the text check', () => {
    const file = makeFile(built('authActionClient'), { relativePath: 'app/actions/items.ts', withAst: false })
    expect(serverActionAuthRule.check(file, project)).toHaveLength(1)
  })

  it('keeps the auth patterns and public paths as they were', () => {
    // A plain client whose .use() is in the file and calls a known check
    expect(check(built('client', `const client = actionClient.use(async ({ next }) => {
  const session = await getSession()
  if (!session) throw new Error('Unauthorized')
  return next({ ctx: { session } })
})`))).toHaveLength(0)
    const file = makeFile(built('actionClient'), { relativePath: 'app/actions/login.ts' })
    expect(serverActionAuthRule.check(file, project)).toHaveLength(0)
  })

  it('applies with and without auth middleware', () => {
    const middleware = makeProject({ hasAuthMiddleware: true })
    expect(check(built('authActionClient'), middleware)).toHaveLength(0)
    expect(check(built('actionClient'), middleware).map(f => f.severity)).toEqual(['info'])

    const apiOnly = makeProject({ hasAuthMiddleware: true, authMiddlewareExcludesPages: true })
    expect(check(built('authActionClient'), apiOnly)).toHaveLength(0)
    expect(check(built('actionClient'), apiOnly).map(f => f.severity)).toEqual(['warning'])
  })

  // dub's real shapes: the client file has no 'use server', and an OTP action's .use() turns signed-in users away
  it('works through the scanner', async () => {
    const result = await scanFiles({
      'lib/actions/safe-action.ts': `import { createSafeActionClient } from 'next-safe-action'
import { getSession } from '../auth'

export const actionClient = createSafeActionClient()

export const authActionClient = actionClient.use(async ({ next }) => {
  const session = await getSession()
  if (!session?.user.id) throw new Error('Unauthorized: Login required.')
  return next({ ctx: { user: session.user } })
})
`,
      'lib/actions/set-default-folder.ts': `"use server";

import { prisma } from "@dub/prisma";
import * as z from "zod/v4";
import { authActionClient } from "./safe-action";

const schema = z.object({ workspaceId: z.string(), folderId: z.string().nullable() });

export const setDefaultFolderAction = authActionClient
  .inputSchema(schema)
  .action(async ({ ctx, parsedInput }) => {
    await prisma.projectUsers.update({
      where: { userId_projectId: { userId: ctx.user.id, projectId: ctx.workspace.id } },
      data: { defaultFolderId: parsedInput.folderId },
    });
  });
`,
      'lib/actions/send-otp.ts': `"use server";

import { prisma } from "@dub/prisma";
import * as z from "zod/v4";
import { throwIfAuthenticated } from "./auth/throw-if-authenticated";
import { actionClient } from "./safe-action";

const schema = z.object({ email: z.string() });

export const sendOtpAction = actionClient
  .inputSchema(schema, { handleValidationErrorsShape: async (ve) => ve })
  .use(throwIfAuthenticated)
  .action(async ({ parsedInput }) => {
    await prisma.emailVerificationToken.create({ data: { identifier: parsedInput.email } });
  });
`,
      'lib/actions/plain.ts': `"use server";

import { prisma } from "@dub/prisma";
import { actionClient } from "./safe-action";

export const plainAction = actionClient.action(async ({ parsedInput }) => {
  await prisma.emailVerificationToken.create({ data: { identifier: parsedInput.email } });
});
`,
    })
    expect(result.findings.filter(f => f.ruleId === 'server-action-auth').map(f => f.file)).toEqual(['lib/actions/plain.ts'])
  })
})

// A write is what outlives the request: a database, a key-value store, a file, another service
describe('server-action-auth on what counts as a mutation', () => {
  const check = (code: string, proj = project) =>
    serverActionAuthRule.check(makeFile(`'use server'\n${code}\n`, { relativePath: 'app/actions/items.ts' }), proj)
  const action = (body: string) => `export async function run(input) {\n  ${body}\n}`

  it('still reports real writes', () => {
    for (const body of [
      // Prisma
      'await prisma.item.create({ data: input })',
      'await prisma.item.update({ where: { id: input.id }, data: input })',
      'await prisma.item.delete({ where: { id: input.id } })',
      'await prisma.item.upsert({ where: { id: input.id }, update: input, create: input })',
      'await prisma.$transaction(async (tx) => { await tx.item.update({ where: { id: input.id }, data: input }) })',
      // Drizzle
      'await db.insert(items).values(input)',
      'await db.update(items).set(input).where(eq(items.id, input.id))',
      'await db.delete(items).where(eq(items.id, input.id))',
      // Supabase
      "await supabase.from('items').insert(input)",
      "await supabase.from('items').update(input).eq('id', input.id)",
      "await supabase.from('items').delete().eq('id', input.id)",
      "await supabase.from('items').upsert(input)",
      "await supabase.storage.from('files').remove([input.path])",
      // Raw SQL
      'await sql`INSERT INTO items (name) VALUES (${input.name})`',
      'await sql`UPDATE items SET name = ${input.name}`',
      "await db.query('DELETE FROM items WHERE id = $1', [input.id])",
      "await client.execute({ sql: 'DELETE FROM items WHERE id = ?', args: [input.id] })",
      // Mongoose and Firestore
      'await Item.create(input)',
      'const item = new Item(input)\n  await item.save()',
      "await db.collection('items').doc(input.id).set(input)",
      "await db.collection('items').doc(input.id).update(input)",
      "await db.collection('items').doc(input.id).delete()",
      // Key-value stores
      'await redis.set(input.key, input.value)',
      'await kv.set(input.key, input.value)',
      'await redis.del(input.key)\n  await cache.set(input.key, input.value)',
      // Another service
      'await stripe.customers.create({ email: input.email })',
      "await fetch(url, { method: 'DELETE' })",
    ]) {
      const findings = check(action(body))
      expect(findings, body).toHaveLength(1)
      expect(findings[0].severity, body).toBe('warning')
      expect(findings[0].message, body).toContain('performs mutations')
    }
  })

  describe('with an effect outside the process that is not read as a write', () => {
    const OUTWARD = [
      "await fetch(url, { method: 'POST', body: JSON.stringify(input) })",
      'await fetch(url, { method: "PUT", body: input })',
      "await fetch(url, { method: 'PATCH', body: input })",
      "await fetch(url, { method: 'post', body: input })",
      "await fetch(url, { method: 'delete' })",
      "const options = { method: 'POST', body: input }\n  await fetch(url, options)",
      "await fetch(url, { method: input.id ? 'PUT' : 'POST', body: input })",
      'await axios.post(url, input)',
      'await axios.put(url, input)',
      'await axios.patch(url, input)',
      'await api.post(url, input)',
      'await env.KV.put(input.key, input.value)',
      'await fs.writeFile(input.path, input.data)',
      'fs.writeFileSync(input.path, input.data)',
      'await writeFile(input.path, input.data)',
      'await fs.promises.appendFile(input.path, input.data)',
      'await fs.unlink(input.path)',
      'await rm(input.path)',
      'await transporter.sendMail(input)',
      'await sendEmail(input)',
      'await s3.send(new PutObjectCommand(input))',
      'await s3.send(new DeleteObjectCommand(input))',
    ]
    const LOCAL = [
      'const rows = []\n  rows.push(input)',
      "const signature = createHmac('sha256', secret).update(input).digest('hex')",
      "const target = new URL(url)\n  target.searchParams.set('a', input)",
      "cookies().set('token', input)",
      'const stream = createStreamableValue()\n  stream.update(input)',
      'const seen = new Map()\n  seen.set(input.id, input)',
      'const client = axios.create({ baseURL: input })',
    ]

    // A signed POST that places an order was only ever reported for its hash's update().
    // Reading calls properly mustn't lose that.
    it('keeps the finding its file had', () => {
      for (const outward of OUTWARD) {
        for (const local of LOCAL) {
          const findings = check(action(`${local}\n  ${outward}`))
          expect(findings, `${local}\n${outward}`).toHaveLength(1)
          expect(findings[0].message).toContain('performs mutations')
        }
      }
    })

    // So many aren't writes: a POST can be a GraphQL read, a token exchange or a captcha check,
    // and a file a temp file. That's for another day, and no file gets a new finding here.
    it('reports nothing on its own, as before', () => {
      for (const outward of OUTWARD) {
        expect(check(action(outward)), outward).toHaveLength(0)
      }
    })

    it('does not take a read for one', () => {
      for (const body of [
        'return fetch(url)',
        "return fetch(url, { method: 'GET' })",
        "return fetch(url, { method: 'HEAD' })",
        "return fetch(url, { cache: 'no-store' })",
        'return axios.get(url)',
        'return api.get(url)',
        'return fs.readFile(input.path)',
        'return s3.send(new GetObjectCommand(input))',
        "return { method: 'card', post: input }",
        '// await axios.post(url, input)',
      ]) {
        expect(check(action(`const rows = []\n  rows.push(input)\n  ${body}`)), body).toHaveLength(0)
      }
      // A form's method is the browser's business
      const file = makeFile(`'use server'\nexport async function run(input) {\n  const rows = []\n  rows.push(input)\n  return <form method="post" action={input} />\n}\n`, { relativePath: 'app/actions/items.tsx' })
      expect(serverActionAuthRule.check(file, project)).toHaveLength(0)
    })

    it('does not read a comment as what the text check found', () => {
      expect(check(action('// rows.push(input)\n  await axios.post(url, input)'))).toHaveLength(0)
    })

    it('leaves a checked action out of it', () => {
      expect(check(`export const a = authActionClient.action(async ({ parsedInput }) => { await axios.post(url, parsedInput) })
export async function b(input) {
  const rows = []
  rows.push(input)
  return rows
}`)).toHaveLength(0)
    })
  })

  // The text check this replaced couldn't see past the generic
  it('reports a write with a generic', () => {
    for (const body of ['await kv.set<number>(input.key, input.value)', 'await redis.set<string>(input.key, input.value)', 'await prisma.item.create<Args>({ data: input })']) {
      expect(check(action(body)), body).toHaveLength(1)
    }
  })

  it('does not count a hash or a stream, which have an update() of their own', () => {
    for (const body of [
      "return createHash('sha256').update(input).digest('hex')",
      "return crypto.createHash('sha256').update(input).digest('hex')",
      "return createHmac('sha256', secret).update(input).update(other).digest('hex')",
      "const hash = createHash('md5')\n  hash.update(input)\n  return hash.digest('hex')",
      "const hmac = crypto.createHmac('sha256', secret)\n  hmac.update(input)\n  hmac.update(other)\n  return hmac.digest('hex')",
      "const cipher = createCipheriv('aes-256-gcm', key, iv)\n  return cipher.update(input, 'utf8', 'hex')",
      'const stream = createStreamableValue()\n  stream.update(input)\n  stream.done()\n  return stream.value',
      'const ui = createStreamableUI()\n  ui.update(input)\n  return ui.value',
      'const aiState = getMutableAIState()\n  aiState.update({ ...aiState.get(), input })',
      // Assigned, not initialized
      'let stream\n  stream = createStreamableValue()\n  stream.update(input)',
    ]) {
      expect(check(action(body)), body).toHaveLength(0)
    }
  })

  it('does not count a push onto an array, whatever it came from', () => {
    for (const body of [
      'const rows = []\n  rows.push(input)\n  return rows',
      'input.items.push(1)\n  return input',
      'const rows = await load()\n  rows.push(input)\n  return rows',
      'const byWeek = {}\n  byWeek[input.week].push(input)\n  return byWeek',
    ]) {
      expect(check(action(body)), body).toHaveLength(0)
    }
  })

  it('still counts a push onto a Firebase reference or an event client, which goes somewhere', () => {
    for (const body of [
      "await db.ref('items').push(input)",
      "await db.ref('items').child(input.id).push(input)",
      "const ref = db.ref('items')\n  await ref.push(input)",
      "const itemsRef = db.ref('items')\n  await itemsRef.push(input)",
      // Hatchet
      "await hatchet.event.push('order:created', input)",
    ]) {
      expect(check(action(body)), body).toHaveLength(1)
    }
  })

  it('does not count a collection or a request being built', () => {
    for (const body of [
      'const seen = new Map()\n  seen.set(input.id, input)\n  seen.delete(input.other)',
      'const seen = new Map<string, Item>()\n  seen.set(input.id, input)',
      'const seen = new Map().set(input.id, input).set(input.other, input)\n  return seen',
      'const seen = new WeakMap()\n  seen.set(input, 1)',
      'const seen = new Set()\n  seen.delete(input)',
      "const params = new URLSearchParams()\n  params.set('a', input)\n  params.delete('b')",
      "const url = new URL(input)\n  url.searchParams.set('a', input)\n  url.searchParams.delete('b')",
      "new URL(input).searchParams.set('a', input)",
      "const headers = new Headers()\n  headers.set('a', input)\n  headers.delete('b')",
      "const res = await fetch(input)\n  res.headers.set('a', input)",
      "const form = new FormData()\n  form.set('a', input)\n  form.delete('b')",
      'const bytes = new Uint8Array(8)\n  bytes.set(input)',
      'const copy = Object.create(null)\n  return copy',
      'const api = axios.create({ baseURL: input })\n  return api.get(input)',
    ]) {
      expect(check(action(body)), body).toHaveLength(0)
    }
  })

  // A cookie changes only the caller's own browser, and they can send any cookie they like. It's
  // often a login, a password gate or a locale switch, which an auth check would only break.
  it("does not count a cookie, which only changes the caller's own browser", () => {
    for (const body of [
      "cookies().set('theme', input)",
      "(await cookies()).set('locale', input, { path: '/' })",
      "(await cookies()).set({ name: 'locale', value: input })",
      "const cookieStore = await cookies()\n  cookieStore.set('theme', input)",
      "const store = cookies()\n  store.set('theme', input)\n  store.delete('other')",
      "cookies().delete('session')",
      "const c = await cookies()\n  c.delete('session')\n  redirect('/login')",
      // A password gate
      "const link = await prisma.link.findUnique({ where: { id: input.id } })\n  if (link.password !== input.password) return { error: 'Invalid' }\n  ;(await cookies()).set(`password_${link.id}`, input.password, { httpOnly: true })",
    ]) {
      expect(check(action(body)), body).toHaveLength(0)
    }
    // ...but it doesn't hide a real write next to it
    expect(check(action("cookies().set('theme', input)\n  await prisma.user.update({ where: { id: input.id }, data: input })"))).toHaveLength(1)
  })

  describe('reads a receiver by what the file defines it as, not by its name', () => {
    it('still reports one whose definition is out of sight', () => {
      for (const body of [
        'await stream.update(input)',
        'await hash.update(input)',
        'await seen.set(input.id, input)',
        'await seen.delete(input.id)',
        'await params.set(input.id, input)',
        'await store.set(input.id, input)',
        'const { stream } = await open(input)\n  await stream.update(input)',
      ]) {
        expect(check(action(body)), body).toHaveLength(1)
      }
    })

    it('still reports one defined as something else', () => {
      for (const body of [
        'const stream = db.stream(input)\n  await stream.update(input)',
        'const hash = await db.hash(input)\n  await hash.update(input)',
        'const headers = db.table(input)\n  await headers.delete(input)',
        'const cookies = db.table(input)\n  await cookies.set(input)',
        'const map = db.map\n  await map.set(input)',
      ]) {
        expect(check(action(body)), body).toHaveLength(1)
      }
    })

    it('still reports a table with the same name as one of these', () => {
      for (const body of [
        'await prisma.hash.update({ where: { id: input.id }, data: input })',
        'await prisma.stream.update({ where: { id: input.id }, data: input })',
        'await prisma.map.delete({ where: { id: input.id } })',
        'await prisma.set.delete({ where: { id: input.id } })',
        'await prisma.headers.update({ where: { id: input.id }, data: input })',
        'await prisma.headers.delete({ where: { id: input.id } })',
        'await prisma.cookies.delete({ where: { id: input.id } })',
        'await prisma.searchParams.delete({ where: { id: input.id } })',
        'await db.cookies.create({ data: input })',
        'await prisma.object.create({ data: input })',
        'await prisma.axios.create({ data: input })',
        'await object.create({ data: input })',
      ]) {
        expect(check(action(body)), body).toHaveLength(1)
      }
    })

    it('still reports a name that also stands for something else in the file', () => {
      expect(check(`export async function a(input) {
  const stream = createStreamableValue()
  stream.update(input)
}
export async function b(input) {
  const stream = db.stream(input)
  await stream.update(input)
}`)).toHaveLength(1)
      // A parameter hides what the file defines, however it's written
      for (const params of ['store, input', '{ store }, input', 'input, ...store', 'input, store = kv']) {
        expect(check(`const store = new Map()
export async function a(${params}) {
  await store.set(input.id, input)
}`), params).toHaveLength(1)
      }
      // So does a name it destructures
      expect(check(`const store = new Map()
export async function a(input) {
  const { store } = await open(input)
  await store.set(input.id, input)
}`)).toHaveLength(1)
    })

    it('reads a name defined as another name', () => {
      expect(check(action('const seen = new Map()\n  const copy = seen\n  copy.set(input.id, input)'))).toHaveLength(0)
      expect(check(action('const seen = db.items\n  const copy = seen\n  await copy.set(input.id, input)'))).toHaveLength(1)
      expect(check(action('const a = b\n  const b = a\n  await a.set(input.id, input)'))).toHaveLength(1)
    })

    it('reads a renamed import by the name it was exported under', () => {
      expect(check(`import { cookies as nextCookies } from 'next/headers'\n${action("(await nextCookies()).set('theme', input)")}`)).toHaveLength(0)
      expect(check(`import { createHash as hash } from 'node:crypto'\n${action("return hash('md5').update(input).digest('hex')")}`)).toHaveLength(0)
      expect(check(`import { db as cookies } from './db'\n${action("await cookies().set('theme', input)")}`)).toHaveLength(1)
    })

    it('does not take what a Map holds for the Map', () => {
      expect(check(action("const models = new Map()\n  await models.get('user').update(input)"))).toHaveLength(1)
    })
  })

  it('does not read comments or strings as calls', () => {
    for (const body of [
      '// await prisma.item.delete({ where: { id: input.id } })',
      '/* await db.update(items).set(input) */',
      "// cookies().set('a', input)\n  return input",
      "return 'run db.delete(items) first'",
      'return `then db.update(items)`',
    ]) {
      expect(check(action(body)), body).toHaveLength(0)
    }
  })

  it('does not read a comment as SQL', () => {
    for (const body of ['// UPDATE: this only reads now', '/* DELETE FROM items once it ships */', '// INSERT the row later']) {
      expect(check(action(body)), body).toHaveLength(0)
    }
    expect(check(`// UPDATE: reads only\n${action('return input')}`)).toHaveLength(0)
    // SQL in a string is still a write, and a comment next to it changes nothing
    expect(check(action("// UPDATE: reads only\n  await db.query('DELETE FROM items')"))).toHaveLength(1)
  })

  it('does not count a checked action\'s writes, read this way, against its neighbors', () => {
    expect(check(`export const a = authActionClient.action(async ({ parsedInput }) => { await db.delete(items).where(parsedInput) })
export async function b(input) {
  const rows = []
  rows.push(input)
  return rows
}`)).toHaveLength(0)
    expect(check(`export const a = authActionClient.action(async ({ parsedInput }) => { await db.query('DELETE FROM items') })
export async function b(input) { return input }`)).toHaveLength(0)
  })

  it('leaves a file Babel can\'t parse to the text check', () => {
    for (const body of ['const rows = []\n  rows.push(input)', 'const stream = createStreamableValue()\n  stream.update(input)', "cookies().set('theme', input)", '// UPDATE: reads only']) {
      const file = makeFile(`'use server'\n${action(body)}\n`, { relativePath: 'app/actions/items.ts', withAst: false })
      expect(serverActionAuthRule.check(file, project), body).toHaveLength(1)
    }
  })

  it('reports at the same severity with auth middleware', () => {
    const middleware = makeProject({ hasAuthMiddleware: true })
    expect(check(action('await db.delete(items)'), middleware).map(f => f.severity)).toEqual(['info'])
    expect(check(action("cookies().set('theme', input)"), middleware)).toHaveLength(0)
    const apiOnly = makeProject({ hasAuthMiddleware: true, authMiddlewareExcludesPages: true })
    expect(check(action('await db.delete(items)'), apiOnly).map(f => f.severity)).toEqual(['warning'])
    expect(check(action('const rows = []\n  rows.push(input)'), apiOnly)).toHaveLength(0)
  })

  // Through the scanner, with the shapes the regex used to trip on
  it('works through the scanner', async () => {
    const result = await scanFiles({
      'app/actions/locale.ts': `"use server";
import { cookies } from "next/headers";

export async function setLocale(locale: string) {
  const cookieStore = await cookies();
  cookieStore.set("NEXT_LOCALE", locale);
}
`,
      'app/actions/hash.ts': `"use server";
import { createHash } from "node:crypto";

export async function hashEmail(email: string) {
  return createHash("sha256").update(email).digest("hex");
}
`,
      'app/actions/items.ts': `"use server";
import { prisma } from "@/lib/prisma";

export async function deleteItem(id: string) {
  await prisma.item.delete({ where: { id } });
}
`,
    })
    expect(result.findings.filter(f => f.ruleId === 'server-action-auth').map(f => f.file)).toEqual(['app/actions/items.ts'])
  })
})

// A model call spends the app's credits on whatever the caller sends, so it's reported like a
// write, for what it is. Such an action often streams through an update() that isn't a write.
describe('server-action-auth on actions that call an AI model', () => {
  const check = (code: string, proj = project, relativePath = 'app/actions/ai.ts') =>
    serverActionAuthRule.check(makeFile(`'use server'\n${code}\n`, { relativePath }), proj)
  const action = (setup: string, body: string) => `${setup}\nexport async function run(input) {\n  ${body}\n}`

  const SDK = "import { generateText } from 'ai'"
  const CALL = 'return generateText({ model, prompt: input })'

  it('reports a model call with no auth check', () => {
    const findings = check(action(SDK, CALL))
    expect(findings).toHaveLength(1)
    expect(findings[0].severity).toBe('warning')
    expect(findings[0].line).toBe(1)
    expect(findings[0].message).toBe('Server action calls an AI model without any authentication check — anyone can call this action and spend your credits')
    expect(findings[0].fix).toContain('Add auth check')
    expect(findings[0].fix).toContain('rate-limit')
  })

  it('reports one that streams to the browser, whose update() is no write', () => {
    for (const code of [
      action("import { streamText } from 'ai'\nimport { createStreamableValue } from '@ai-sdk/rsc'", `const stream = createStreamableValue()
  ;(async () => {
    const { textStream } = streamText({ model, prompt: input })
    for await (const delta of textStream) stream.update(delta)
    stream.done()
  })()
  return { value: stream.value }`),
      action("import { streamObject } from 'ai'\nimport { createStreamableValue } from 'ai/rsc'", `const stream = createStreamableValue()
  const { partialObjectStream } = streamObject({ model, schema, prompt: input })
  for await (const partial of partialObjectStream) stream.update(partial)
  stream.done()
  return stream.value`),
      action("import { streamUI, getMutableAIState } from '@ai-sdk/rsc'", `const aiState = getMutableAIState()
  aiState.update({ ...aiState.get(), input })
  return streamUI({ model, prompt: input, text: ({ content }) => content })`),
    ]) {
      const findings = check(code)
      expect(findings, code).toHaveLength(1)
      expect(findings[0].message, code).toContain('calls an AI model')
    }
  })

  it("reads each of the AI SDK's model calls", () => {
    for (const name of ['generateText', 'streamText', 'generateObject', 'streamObject', 'embed', 'embedMany', 'generateImage', 'experimental_generateImage', 'experimental_generateSpeech', 'experimental_transcribe', 'rerank']) {
      expect(check(action(`import { ${name} } from 'ai'`, `return ${name}({ model, prompt: input })`)), name).toHaveLength(1)
    }
    expect(check(action("import { streamUI } from 'ai/rsc'", 'return streamUI({ model, prompt: input })'))).toHaveLength(1)
    expect(check(action("import { generateText as ask } from 'ai'", 'return ask({ model, prompt: input })'))).toHaveLength(1)
  })

  it('reads a model client the file makes', () => {
    for (const [setup, body] of [
      ["import { GoogleGenerativeAI } from '@google/generative-ai'", 'const genAI = new GoogleGenerativeAI(key)\n  return genAI.getGenerativeModel({ model: name }).generateContent(input)'],
      ["import { GoogleGenAI } from '@google/genai'", 'const ai = new GoogleGenAI({ apiKey: key })\n  return ai.models.generateContent({ model: name, contents: input })'],
      ["import { ChatOpenAI } from '@langchain/openai'", 'const llm = new ChatOpenAI({ model: name })\n  return llm.invoke(input)'],
      ["import { ChatAnthropic as Chat } from '@langchain/anthropic'", 'return new Chat({ model: name }).invoke(input)'],
      ["import Anthropic from '@anthropic-ai/sdk'", 'const client = new Anthropic()\n  return client.messages.stream({ model: name, messages: input })'],
    ]) {
      const findings = check(action(setup, body))
      expect(findings, setup).toHaveLength(1)
      expect(findings[0].message, setup).toContain('calls an AI model')
    }
  })

  it('reads the common model APIs, wherever the client comes from', () => {
    for (const call of [
      'openai.chat.completions.create({ model: name, messages: input })',
      'openai.chat.completions.stream({ model: name, messages: input })',
      'openai.beta.chat.completions.parse({ model: name, messages: input })',
      'groq.chat.completions.create({ model: name, messages: input })',
      'getClient().chat.completions.create({ model: name, messages: input })',
      'anthropic.messages.create({ model: name, messages: input })',
      'anthropic.messages.stream({ model: name, messages: input })',
      'anthropicClient.messages.create({ model: name, messages: input })',
    ]) {
      const findings = check(`import { openai, groq, anthropic, anthropicClient, getClient } from './ai'\n${action('', `return ${call}`)}`)
      expect(findings, call).toHaveLength(1)
      expect(findings[0].message, call).toContain('calls an AI model')
    }
    // ...and a rate limit clears them like any other
    expect(check(action('', 'await ratelimit.limit(ip)\n  return openai.chat.completions.create({ model: name, messages: input })'))).toHaveLength(0)
  })

  it('still reads the same words elsewhere as a write', () => {
    for (const call of [
      'prisma.completions.create({ data: input })',
      'prisma.chat.create({ data: input })',
      'prisma.chat.completions.delete({ where: { id: input.id } })',
      'prisma.message.create({ data: input })',
      'db.messages.create({ data: input })',
      'twilio.messages.create({ to: input.to, body: input.body })',
      'mg.messages.create(domain, input)',
      'anthropic.messages.delete(input.id)',
    ]) {
      const findings = check(action('', `return ${call}`))
      expect(findings, call).toHaveLength(1)
      expect(findings[0].message, call).toContain('performs mutations')
    }
  })

  it('does not take other imports for a model call', () => {
    for (const code of [
      // Same names from elsewhere
      action("import { generateText } from './lib/text'", 'return generateText(input)'),
      action('function embed(input) { return input }', 'return embed(input)'),
      // The AI SDK's other exports
      action("import { generateId, convertToModelMessages } from 'ai'", 'return { id: generateId(), messages: convertToModelMessages(input) }'),
      action("import { createStreamableValue } from '@ai-sdk/rsc'", 'return createStreamableValue(input).value'),
      // A model provider's factory makes no call by itself, and a message class isn't a client
      action("import { openai } from '@ai-sdk/openai'", "return openai('gpt-4').modelId"),
      action("import { HumanMessage } from '@langchain/core/messages'", 'return new HumanMessage(input).content'),
      // Imported, never made
      action("import OpenAI from 'openai'", 'return input as OpenAI.Message'),
      action("import type { GenerateTextResult } from 'ai'", 'return input as GenerateTextResult'),
      // A name it's only mentioned by
      action(SDK, '// return generateText({ model, prompt: input })\n  return input'),
    ]) {
      expect(check(code), code).toHaveLength(0)
    }
  })

  it('reports a write first, with a model call next to it', () => {
    const findings = check(action(SDK, 'const { text } = await generateText({ model, prompt: input })\n  await prisma.note.create({ data: { text } })'))
    expect(findings).toHaveLength(1)
    expect(findings[0].message).toContain('performs mutations')
    expect(findings[0].fix).not.toContain('rate-limit')
  })

  it('counts the checks a write counts', () => {
    expect(check(action(SDK, `const session = await auth()\n  if (!session) throw new Error('Unauthorized')\n  ${CALL}`))).toHaveLength(0)
    expect(check(`${SDK}\nexport const run = authActionClient.action(async ({ parsedInput }) => generateText({ model, prompt: parsedInput }))`)).toHaveLength(0)
    expect(check(action(SDK, CALL), project, 'app/actions/contact.ts')).toHaveLength(0)
    expect(check(action(SDK, CALL), project, 'tests/actions/ai.ts')).toHaveLength(0)
    // ...and a checked action's model call doesn't count against a neighbor
    expect(check(`${SDK}
export const a = authActionClient.action(async ({ parsedInput }) => generateText({ model, prompt: parsedInput }))
export async function b(input) { return input }`)).toHaveLength(0)
    expect(check(`${SDK}
export const a = authActionClient.action(async () => 1)
export async function b(input) { return generateText({ model, prompt: input }) }`)).toHaveLength(1)
  })

  // Anyone can still call it, but the bill has a limit: what a public action needs
  it('accepts a rate limit in place of an auth check', () => {
    for (const limit of [
      'const { success } = await ratelimit.limit(ip)\n  if (!success) throw new Error("Too many requests")',
      'await checkRateLimit(ip)',
      'await rateLimit(ip)',
      'await enforceRateLimiter(ip)',
    ]) {
      expect(check(action(SDK, `${limit}\n  ${CALL}`)), limit).toHaveLength(0)
    }
    expect(check(action(`${SDK}\nimport { Ratelimit } from '@upstash/ratelimit'`, CALL))).toHaveLength(0)
    // A comment doesn't limit anything, and neither does "delimiter"
    expect(check(action(SDK, `// TODO: rate limit this\n  ${CALL}`))).toHaveLength(1)
    expect(check(action(SDK, `const delimiter = ','\n  ${CALL}`))).toHaveLength(1)
    // A rate limit is no check on a write
    expect(check(action(SDK, 'await ratelimit.limit(ip)\n  await prisma.note.create({ data: input })'))).toHaveLength(1)
  })

  it('rates it by the auth middleware like a write', () => {
    const middleware = check(action(SDK, CALL), makeProject({ hasAuthMiddleware: true }))
    expect(middleware).toHaveLength(1)
    expect(middleware[0].severity).toBe('info')
    expect(middleware[0].message).toBe('Server action calls an AI model without an inline auth check (middleware auth detected — verify coverage)')
    expect(middleware[0].fix).toContain('in the action')

    const apiOnly = check(action(SDK, CALL), makeProject({ hasAuthMiddleware: true, authMiddlewareExcludesPages: true }))
    expect(apiOnly).toHaveLength(1)
    expect(apiOnly[0].severity).toBe('warning')
    expect(apiOnly[0].message).toBe("Server action calls an AI model without any authentication check (middleware auth detected, but its matcher doesn't cover pages)")
  })

  it('works through the scanner', async () => {
    const result = await scanFiles({
      'lib/ai/summarize.ts': `"use server";
import { anthropic } from "@ai-sdk/anthropic";
import { createStreamableValue } from "@ai-sdk/rsc";
import { streamText } from "ai";

export async function summarize(prompt: string) {
  const stream = createStreamableValue();
  (async () => {
    const { textStream } = streamText({ model: anthropic("claude-haiku-5-5"), prompt });
    for await (const delta of textStream) stream.update(delta);
    stream.done();
  })();
  return { value: stream.value };
}
`,
    })
    const findings = result.findings.filter(f => f.ruleId === 'server-action-auth')
    expect(findings.map(f => f.file)).toEqual(['lib/ai/summarize.ts'])
    expect(findings[0].message).toContain('calls an AI model')
  })
})
