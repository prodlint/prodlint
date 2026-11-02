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

  // Its write is part of the public action, like one written inline
  it('covers a helper only an action behind a guest guard reaches', () => {
    const guest = 'export const a = actionClient.use(throwIfAuthenticated).action(async ({ parsedInput }) => store(parsedInput))'
    expect(check(`'use server'\nasync function store(x) { await db.item.create({ data: x }) }\n${guest}\n`)).toHaveLength(0)
    expect(check(`'use server'\nconst store = async (x) => { await db.item.create({ data: x }) }\n${guest}\n`)).toHaveLength(0)
    // ...unless an open export reaches it too
    expect(check(`'use server'\nasync function store(x) { await db.item.create({ data: x }) }\n${guest}\nexport async function b(x) { return store(x) }\n`)).toHaveLength(1)
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

    it('covers a helper only checked actions can reach, next to a plain export', () => {
      expect(check(`'use server'
async function remove(id) { await db.delete(items).where({ id }) }
export const a = authActionClient.action(({ parsedInput }) => remove(parsedInput.id))
export async function b() { return 1 }
`)).toHaveLength(0)
      // Through another helper, and by a const
      expect(check(`'use server'
const remove = async (id) => { await db.delete(items).where({ id }) }
function outer(id) { return remove(id) }
export const a = authActionClient.action(({ parsedInput }) => outer(parsedInput.id))
export async function b() { return 1 }
`)).toHaveLength(0)
      // What runs as the module loads isn't behind the check, and neither is what it builds
      expect(check(`'use server'
async function remove(id) { await db.delete(items).where({ id }) }
const ready = remove(1)
export const a = authActionClient.action(({ parsedInput }) => remove(parsedInput.id))
export async function b() { return 1 }
`)).toHaveLength(1)
      expect(check(`'use server'
async function remove(id) { await db.delete(items).where({ id }) }
remove(1)
export const a = authActionClient.action(({ parsedInput }) => remove(parsedInput.id))
export async function b() { return 1 }
`)).toHaveLength(1)
      expect(check(`'use server'
const remover = wrap(async (id) => { await db.delete(items).where({ id }) })
export const a = authActionClient.action(({ parsedInput }) => remover(parsedInput.id))
export async function b() { return 1 }
`)).toHaveLength(1)
      // No action reaches it at all: as before
      expect(check(`'use server'
async function remove(id) { await db.delete(items).where({ id }) }
export async function b() { return 1 }
`)).toHaveLength(1)
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
        // ...which can't reach a helper of this file
        expect(check(`'use server'
async function remove(id) { await db.delete(items).where({ id }) }
export const a = authActionClient.action(({ parsedInput }) => remove(parsedInput.id))
${reexport}
`), reexport).toHaveLength(0)
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
    ]) {
      const findings = check(action(body))
      expect(findings, body).toHaveLength(1)
      expect(findings[0].severity, body).toBe('warning')
      expect(findings[0].message, body).toContain('performs mutations')
    }
  })

  describe('with an effect outside the process that is not read as a write', () => {
    // These count by themselves: see 'server-action-auth on what goes out and stays out'
    const SHOWN = [
      "await fetch(url, { method: 'POST', body: JSON.stringify(input) })",
      'await fetch(url, { method: "PUT", body: input })',
      "await fetch(url, { method: 'PATCH', body: input })",
      "await fetch(url, { method: 'post', body: input })",
      "await fetch(url, { method: 'delete' })",
      "const options = { method: 'POST', body: input }\n  await fetch(url, options)",
      "await fetch(url, { method: input.id ? 'PUT' : 'POST', body: input })",
      'await env.KV.put(input.key, input.value)',
      'await transporter.sendMail(input)',
      'await resend.emails.send(input)',
      "const method = 'POST'\n  await fetch(url, { method })",
      "await fetch(url, { 'method': 'POST' })",
      'await fetch(url, { method: `POST` })',
    ]
    // A client or a helper from another file, or one that isn't imported at all, can do what this can't see
    const OUTWARD = [
      'await axios.post(url, input)',
      'await axios.put(url, input)',
      'await axios.patch(url, input)',
      'await api.post(url, input)',
      'await apiClient.POST(url, input)',
      'await apiClient.PATCH(url, input)',
      'await fs.writeFile(input.path, input.data)',
      'fs.writeFileSync(input.path, input.data)',
      'await writeFile(input.path, input.data)',
      'await fs.promises.appendFile(input.path, input.data)',
      'await fs.unlink(input.path)',
      'await rm(input.path)',
      'await sendEmail(input)',
      'await s3.send(new PutObjectCommand(input))',
      'await s3.send(new DeleteObjectCommand(input))',
      'await ses.send(new SendEmailCommand(input))',
      // However the method gets there
      "init.method = 'POST'\n  await fetch(url, init)",
      "await api(url, 'POST', input)",
      // More of the file system
      'await fs.rename(input.from, input.to)',
      'await fs.copyFile(input.from, input.to)',
      'await fs.mkdir(input.path)',
      // Writes through a helper, or a store this rule doesn't know: named like one
      'await deletePhotoAndFiles(input.id)',
      'await updateRow(input)',
      'await addTagsToPhotos(input)',
      'await storeData(input)',
      'await markRead(input)',
      'await client.users.updateAvatar(input)',
      'await remove(input.id)',
      'await update(input)',
      "await set(ref(db, 'items'), input)",
      "await push(ref(db, 'items'), input)",
      "await supabase.rpc('bump', input)",
      "await queue.add('job', input)",
      'await client.mutation(api.items.add, input)',
      'await sql.transaction(input)',
      'await kv.expireat(input.key, 1)',
      // Anything not shown harmless: no list of verbs holds them all
      'await clearCart(input.id)',
      'await resetPassword(input.id, input.pw)',
      'await bank.transferFunds(input)',
      'await guardarUsuario(input)',
      'await eliminarProducto(input.id)',
      'await stripe.refunds.process(input)',
      'await wipe(input)',
      // It starts like a read, and says it also writes
      'await getOrCreateUser(input)',
      'await findOrCreate(input)',
      'await fetchAndStore(input)',
      'await loadAndSave(input)',
      'await checkIn(input)',
      // A factory's word in a name that makes a record
      'await createUserAction(input)',
      'await createClientInvoice(input)',
      'await mustCreateUser(input)',
      // A model behind a helper, as often as not
      'await generateSummary(input)',
      'await generateReport(input)',
      'await generateAndSaveToken(input)',
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
      for (const outward of [...SHOWN, ...OUTWARD]) {
        for (const local of LOCAL) {
          const findings = check(action(`${local}\n  ${outward}`))
          expect(findings, `${local}\n${outward}`).toHaveLength(1)
          expect(findings[0].severity).toBe('warning')
        }
      }
      for (const outward of OUTWARD) {
        expect(check(action(`${LOCAL[0]}\n  ${outward}`))[0].message, outward).toContain('performs mutations')
      }
    })

    // It can't tell what these do, and most of the clients it read forward the caller's token
    it('reports nothing on its own', () => {
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
        'return s3.send(new ListObjectsV2Command(input))',
        "return { method: 'card', post: input }",
        '// await axios.post(url, input)',
        'const supabase = createClient()\n  return supabase.from(input).select()',
        'const supabase = createServerClient(url, key)\n  return supabase.from(input).select()',
        'const client = createAdminClient()\n  return client.get(input)',
        'setTimeout(input, 100)',
        'const date = new Date()\n  date.setFullYear(2020)\n  date.setUTCHours(1)\n  return date',
        "setCookie('a', input)\n  destroyCookie('b')",
        "updateTag('items')",
        'const seen = new Set()\n  seen.add(input)',
        'new Set().add(input)',
        'return getUser(input)',
        'return findItems(input)',
        'return generateId()',
        'return generateSlug(input)',
        // Reads and checks, by their first word
        'return getLocale()',
        'return isAdmin(input)',
        'return parseInput(input)',
        'return formatDate(input)',
        'return validateInput(input)',
        'return fetchItems(input)',
        // The language, the framework and a schema
        'return JSON.stringify(input)',
        'return Object.keys(input)',
        'return input.items.map(String).join()',
        'return new Date().toISOString()',
        'console.log(input)',
        "redirect('/')",
        "revalidatePath('/')",
        'return z.object({ a: z.string().min(1) }).parse(input)',
        'return schema.safeParse(input)',
        // A query, not a write
        'return prisma.item.findMany({ where: input })',
        'return db.select().from(items).where(eq(items.id, input))',
        "return db.ref('items').get()",
        "return db.ref('items').child(input).get()",
        // Sign-in is public by design
        'return supabase.auth.signInWithPassword(input)',
        'return supabase.auth.resetPasswordForEmail(input)',
        'return signIn(input)',
        'return signOut()',
        "return updated",
        'return Promise.reject(input)',
      ]) {
        expect(check(action(`const rows = []\n  rows.push(input)\n  ${body}`)), body).toHaveLength(0)
      }
      // A form's method is the browser's business
      const file = makeFile(`'use server'\nexport async function run(input) {\n  const rows = []\n  rows.push(input)\n  return <form method="post" action={input} />\n}\n`, { relativePath: 'app/actions/items.tsx' })
      expect(serverActionAuthRule.check(file, project)).toHaveLength(0)
      const upper = makeFile(`'use server'\nexport async function run(input) {\n  const rows = []\n  rows.push(input)\n  return <form method="POST" action={input} />\n}\n`, { relativePath: 'app/actions/items.tsx' })
      expect(serverActionAuthRule.check(upper, project)).toHaveLength(0)
    })

    it('reads a helper in the file by its body, not its name', () => {
      expect(check("function wipe(rows) { return rows.length }\nexport async function run(input) {\n  const rows = []\n  rows.push(input)\n  return wipe(rows)\n}")).toHaveLength(0)
      expect(check("const wipe = (rows) => rows.length\nexport async function run(input) {\n  const rows = []\n  rows.push(input)\n  return wipe(rows)\n}")).toHaveLength(0)
      expect(check("export async function run(input) {\n  const rows = []\n  rows.push(input)\n  return (() => rows.length)()\n}")).toHaveLength(0)
      expect(check("function wipe(id) { return bank.transferFunds(id) }\nexport async function run(input) {\n  const rows = []\n  rows.push(input)\n  return wipe(rows)\n}")).toHaveLength(1)
    })

    it('reads a call by the package it comes from', () => {
      for (const [setup, body] of [
        ["import { anthropic } from '@ai-sdk/anthropic'", "return anthropic('claude')"],
        ["import { tool } from 'ai'", 'return tool({ description: input })'],
        ["import { compare } from 'bcryptjs'", 'return compare(input.a, input.b)'],
        ["import { sign } from 'jsonwebtoken'", 'return sign(input, secret)'],
        ["import { join } from 'node:path'", 'return join(input.a, input.b)'],
        ["import { after } from 'next/server'", 'after(() => 1)'],
        ["import { refresh } from 'next/cache'", 'refresh()'],
      ]) {
        expect(check(`${setup}\n${action(`const rows = []\n  rows.push(input)\n  ${body}`)}`), body).toHaveLength(0)
      }
      // The name alone isn't enough to go on
      expect(check(`import { refresh } from '@/lib/tokens'\n${action('const rows = []\n  rows.push(input)\n  refresh(input)')}`)).toHaveLength(1)
    })

    it('asks whatever a question is about', () => {
      for (const body of ['return canDeleteItem(input)', 'return hasUpdatePermission(input)', 'return isDeleted(input)', 'return user.canCreate(input)']) {
        expect(check(action(`const rows = []\n  rows.push(input)\n  ${body}`)), body).toHaveLength(0)
      }
    })

    it('reads a noun as a noun, unless a verb comes after it', () => {
      for (const body of ['return getPost(input)', 'return getStore(input)', 'return fetchRecord(input)', 'return getOrders(input)', 'return getUserOrThrow(input)', 'return getOrNull(input)', 'return getAndroidVersion(input)']) {
        expect(check(action(`const rows = []\n  rows.push(input)\n  ${body}`)), body).toHaveLength(0)
      }
      for (const body of ['return fetchCreateOrder(input)', 'return getUpdateStatus(input)', 'return getOrInsert(input)']) {
        expect(check(action(`const rows = []\n  rows.push(input)\n  ${body}`)), body).toHaveLength(1)
      }
    })

    it('does not take a call it can\'t name for a read', () => {
      for (const body of [
        'await handlers[input.kind](input)',
        'await getHandler()(input)',
        // Not a command, and not a word that's a read
        'await client.send(new Message(input))',
        'await budget(input)',
        // Where raw SQL goes
        'await db.query(input)',
        'await db.execute(input)',
        'await stmt.run(input)',
        // A write behind what could be anything
        'await this.save2(input)',
        // A method up to its caller
        'await fetch(url, input)',
        'await fetch(url, { ...input })',
        'await fetch(url, { method: input.method })',
        // A tag that hides a write
        'await sql`UPDATE ${input.table} ${input.changes}`',
        'await env.API.fetch(url, input)',
        // A function handed to something that calls it
        'await Promise.all(input.ids.map(deletePhoto))',
        'input.ids.forEach(sendEmail)',
        'await load().then(notifyUser)',
        'await Array.from(input.ids).map(deletePhoto)',
        'new Set(input.ids).forEach(sendEmail)',
        // An array that isn't this file's
        'queue.push(input)',
        'queue.unshift(input)',
        // An account's, not the session's
        'await supabase.auth.admin.deleteUser(input)',
        'await auth.deleteUser(input)',
      ]) {
        const setup = body.includes('queue') ? "import { queue } from './queue'\n" : ''
        expect(check(`${setup}${action(`const seen = new Map()\n  seen.set(input, 1)\n  ${body}`)}`), body).toHaveLength(1)
      }
    })

    it('reads a tag only when it has an SQL word', () => {
      expect(check(action('const seen = new Map()\n  seen.set(input, 1)\n  return gql`query { a }`'))).toHaveLength(0)
      expect(check(action('const seen = new Map()\n  seen.set(input, 1)\n  return css`color: red`'))).toHaveLength(0)
    })

    it('takes a value for a value', () => {
      for (const body of ['return Item.find(input)', 'return items.filter(input)', 'const filter = { a: 1 }\n  return Item.find(filter)', 'return input.items.map(getName)', 'return input.items.map(String)', 'return input.items.filter(Boolean)']) {
        expect(check(action(`const seen = new Map()\n  seen.set(input, 1)\n  ${body}`)), body).toHaveLength(0)
      }
    })

    it('does not take a fetch or a parameter for the import of that name', () => {
      expect(check(`import fetch from 'node-fetch'\n${action('const seen = new Map()\n  seen.set(input, 1)\n  return fetch(url, input)')}`)).toHaveLength(1)
      expect(check(`import fetch from 'node-fetch'\n${action('const seen = new Map()\n  seen.set(input, 1)\n  return fetch(url)')}`)).toHaveLength(0)
      expect(check(`import { fetch as send } from 'undici'\n${action('const seen = new Map()\n  seen.set(input, 1)\n  return send(url, input)')}`)).toHaveLength(1)
      expect(check(`import { eq } from 'drizzle-orm'\nexport async function run(eq, input) {\n  const seen = new Map()\n  seen.set(input, 1)\n  return eq(input)\n}`)).toHaveLength(1)
      expect(check(`function fetch(a, b) { return a }\n${action('const seen = new Map()\n  seen.set(input, 1)\n  return fetch(url, input)')}`)).toHaveLength(0)
    })

    it('leaves a public-named path out of it, as it does a write', () => {
      const file = makeFile(`'use server'\n${action('const seen = new Map()\n  seen.set(input, 1)\n  await sendEmail(input)')}\n`, { relativePath: 'app/actions/contact.ts' })
      expect(serverActionAuthRule.check(file, project)).toHaveLength(0)
    })

    it('reads a write method next to a call named like a read', () => {
      for (const body of ["return fetchData(url, { method: 'POST' })", 'return fetchData(url, { method: `POST` })', "return fetchData(url, { method: 'post' })"]) {
        expect(check(action(`const seen = new Map()\n  seen.set(input, 1)\n  ${body}`)), body).toHaveLength(1)
      }
    })

    it('reads a value the file got from a call by that call', () => {
      expect(check(action('const seen = new Map()\n  seen.set(input, 1)\n  const t = getTranslations()\n  return t(input)'))).toHaveLength(0)
      expect(check(action('const seen = new Map()\n  seen.set(input, 1)\n  const send = makeSender()\n  return send(input)'))).toHaveLength(1)
    })

    it('does not take loading a module for a write', () => {
      expect(check(action("const seen = new Map()\n  seen.set(input, 1)\n  const mod = await import('./helpers')\n  return mod"))).toHaveLength(0)
    })

    it('reads an unknown call only next to something the text check found', () => {
      expect(check(action('await clearCart(input.id)'))).toHaveLength(0)
      expect(check(action('await bank.transferFunds(input)'))).toHaveLength(0)
    })

    it('does not vouch for a function it was handed', () => {
      expect(check('export async function run(fn, input) {\n  const rows = []\n  rows.push(input)\n  return fn(rows)\n}')).toHaveLength(1)
    })

    // A generic fetch helper, with the method up to its caller
    it('reads a type that names a write method as one', () => {
      expect(check(`type Method = 'GET' | 'POST'\nexport async function api(path, method: Method) {\n  const params = new URLSearchParams()\n  params.set('a', path)\n  return fetch(path, { method })\n}`)).toHaveLength(1)
      expect(check(`export async function api(path, method?: 'GET' | 'DELETE') { return fetch(path, { method }) }`)).toHaveLength(1)
      expect(check(`type Method = 'GET' | 'HEAD'\nexport async function api(path) {\n  const params = new URLSearchParams()\n  params.set('a', path)\n  return fetch(path)\n}`)).toHaveLength(0)
    })

    it('reads a renamed import by the name it was exported under', () => {
      for (const setup of ["import { writeFile as save } from 'fs'", "import { sendMail as notify } from './mail'"]) {
        const callee = setup.includes('save') ? 'save' : 'notify'
        expect(check(`${setup}\n${action(`const rows = []\n  rows.push(input)\n  await ${callee}(input)`)}`), setup).toHaveLength(1)
      }
      expect(check(`import { getUser as updateUser } from './users'\n${action('const rows = []\n  rows.push(input)\n  await updateUser(input)')}`)).toHaveLength(0)
    })

    // The text check reads comments too. What it found there stays reported only next to one of these.
    it('keeps the finding when the text check only found a comment', () => {
      expect(check(action('// rows.push(input)\n  await axios.post(url, input)'))).toHaveLength(1)
      expect(check(action('// ===== DELETE =====\n  await axios.post(url, input)'))).toHaveLength(1)
      expect(check(action('// rows.push(input)\n  return axios.get(url)'))).toHaveLength(0)
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

  // ...or the method's name, which it wanted whole
  it('reports the writes the text check never read', () => {
    for (const body of [
      // Prisma's bulk methods
      'await prisma.item.createMany({ data: input })',
      'await prisma.item.createManyAndReturn({ data: input })',
      'await prisma.item.updateMany({ where: input, data: input })',
      'await prisma.item.deleteMany({ where: { id: input.id } })',
      'await prisma.$executeRawUnsafe(input)',
      'await prisma.$executeRaw`${input}`',
      // Mongo and Mongoose
      'await db.collection(input).insertOne(input)',
      'await Item.insertMany(input)',
      'await db.collection(input).updateOne(input, input)',
      'await db.collection(input).deleteOne(input)',
      'await db.collection(input).replaceOne(input, input)',
      'await db.collection(input).bulkWrite(input)',
      'await Item.findOneAndUpdate(input, input)',
      'await Item.findOneAndDelete(input)',
      'await Item.findByIdAndUpdate(input.id, input)',
      'await Item.findByIdAndDelete(input.id)',
      // Firestore's functions
      'await setDoc(doc(db, input.id), input)',
      'await addDoc(collection(db, input.path), input)',
      'await updateDoc(doc(db, input.id), input)',
      'await deleteDoc(doc(db, input.id))',
      // Redis
      'await redis.hset(input.key, input)',
      'await redis.hdel(input.key, input.field)',
      'await redis.sadd(input.key, input.value)',
      'await redis.srem(input.key, input.value)',
      'await redis.lpush(input.key, input.value)',
      'await redis.rpush(input.key, input.value)',
      'await redis.zadd(input.key, input.value)',
      'await redis.incr(input.key)',
      'await kv.incrby(input.key, 1)',
      'await redis.decr(input.key)',
      'await redis.del(input.key)',
      'await redis.setex(input.key, 60, input.value)',
    ]) {
      const findings = check(action(body))
      expect(findings, body).toHaveLength(1)
      expect(findings[0].message, body).toContain('performs mutations')
    }
    // A name that only looks like one
    expect(check(`export async function run(setDoc, input) { return setDoc(input) }`)).toHaveLength(0)
    expect(check(action('return items.findOneAndUpdatedAt(input)'))).toHaveLength(0)
  })

  it('reads a Firestore function by what it was imported as', () => {
    expect(check(`import { setDoc as write } from 'firebase/firestore'\n${action('await write(doc(db, input.id), input)')}`)).toHaveLength(1)
    expect(check(`import { deleteDoc } from 'firebase/firestore'\n${action('await deleteDoc(doc(db, input.id))')}`)).toHaveLength(1)
    expect(check(`import { setDoc } from './local'\n${action('return setDoc(input)')}`)).toHaveLength(0)
  })

  // The regression a local call could hide: the text check caught these through the cookie
  it('keeps a real write next to a cookie', () => {
    for (const body of [
      "await prisma.cartItem.deleteMany({ where: { cartId: input } })\n  ;(await cookies()).delete('cart')",
      "await deleteDoc(doc(db, input))\n  cookies().set('a', input)",
      "await db.collection('rows').insertOne(input)\n  const rows = []\n  rows.push(input)",
      "await redis.hset(input.key, input)\n  cookies().delete('a')",
      "await supabase.rpc('bump', input)\n  cookies().delete('a')",
      "await queue.add('job', input)\n  const seen = new Map()\n  seen.set(input, 1)",
    ]) {
      expect(check(action(body)), body).toHaveLength(1)
    }
  })

  // Every request sees it, and any caller can change what the next one gets. A cache's just
  // as shared, but what's in it can be fetched again.
  describe('with a collection at module level', () => {
    it('counts one that holds the app\'s data', () => {
      for (const code of [
        'const roles = new Map()\nexport async function grantRole(u, r) { roles.set(u, r) }',
        'const roles = new Map()\nexport async function revokeRole(u) { roles.delete(u) }',
        'const todos = []\nexport async function addTodo(t) { todos.push(t) }',
        'let todos = []\nexport async function addTodo(t) { todos.push(t) }',
        'const names = new Set()\nexport async function removeName(n) { names.delete(n) }',
        'export const users = new Map()\nexport async function addUser(u) { users.set(u.id, u) }',
      ]) {
        const findings = check(code)
        expect(findings, code).toHaveLength(1)
        expect(findings[0].message, code).toContain('performs mutations')
      }
    })

    it('does not count a cache or a limit map', () => {
      for (const name of ['cache', 'memCache', 'queryCache', 'memo', 'memoized', 'lruCache', 'rateLimitMap', 'rateLimitStore', 'rate_limits', 'limiter']) {
        expect(check(`const ${name} = new Map()\nexport async function run(k) { ${name}.set(k, 1) }`), name).toHaveLength(0)
      }
      expect(check('const recentCache = []\nexport async function run(k) { recentCache.push(k) }')).toHaveLength(0)
    })

    // Inside another word, or what anyone could use to get around a check
    it('counts one that only sounds like a cache', () => {
      for (const [name, write] of [
        ['memories', 'memories.set(k, 1)'],
        ['memorial', 'memorial.set(k, 1)'],
        ['attempts', 'attempts.delete(k)'],
        ['banned', 'banned.delete(k)'],
        ['bannedIPs', 'bannedIPs.delete(k)'],
        ['hits', 'hits.set(k, 1)'],
        ['creditLimits', 'creditLimits.set(k, 1)'],
        ['delimiters', 'delimiters.set(k, 1)'],
      ]) {
        expect(check(`const ${name} = new Map()\nexport async function run(k) { ${write} }`), name).toHaveLength(1)
      }
    })

    it('does not count one made in the action', () => {
      expect(check('export async function run(k) {\n  const roles = new Map()\n  roles.set(k, 1)\n  const todos = []\n  todos.push(k)\n  return [roles, todos]\n}')).toHaveLength(0)
    })
  })

  describe('with a push()', () => {
    it('reads a reference from what the file defines it as', () => {
      for (const body of [
        "const messages = db.ref('messages')\n  await messages.push(input)",
        "const todos = firebase.database().ref('todos')\n  await todos.push(input)",
        "const items = db.ref('a').child(input.id)\n  await items.push(input)",
      ]) {
        expect(check(action(body)), body).toHaveLength(1)
      }
    })

    it('reads a named event from its arguments', () => {
      for (const body of ["await hatchet.events.push('order:created', input)", "await hatchet.event.push('order:created', input)", 'await bus.push(`order:${input.id}`, input)']) {
        expect(check(action(body)), body).toHaveLength(1)
      }
    })

    it('does not go by the name alone', () => {
      for (const body of [
        'const event = []\n  event.push(input)\n  return event',
        'const ref = []\n  ref.push(input)\n  return ref',
        "const rows = []\n  rows.push('a', 'b')\n  return rows",
        'state.events.push(input)',
        'return ref.current.push(input)',
      ]) {
        expect(check(action(body)), body).toHaveLength(0)
      }
    })
  })

  describe('with a name that also stands for something else', () => {
    it('still reports an import, a loop variable or a catch parameter of that name', () => {
      for (const code of [
        "import { store } from './store'\nexport async function a() { const store = await cookies(); store.set('a', 1) }\nexport async function b(input) { await store.set('b', input) }",
        'export async function a(items) {\n  const item = new Map()\n  item.set(1, 2)\n  for (const item of items) await item.set(1, 2)\n}',
        'export async function a(items) {\n  const item = new Map()\n  item.set(1, 2)\n  for (const item in items) await item.set(1, 2)\n}',
        'export async function a(input) {\n  const e = new Map()\n  e.set(1, 2)\n  try { await getRun(input) } catch (e) { await e.set(1, 2) }\n}',
        'export async function a(input) {\n  const store = new Map()\n  store.set(1, 2)\n}\nexport async function b(input) {\n  let store\n  ;({ store } = await getStore(input))\n  await store.set(1, 2)\n}',
        'function store() {}\nexport async function a(input) {\n  const store = new Map()\n  store.set(1, 2)\n}\nexport async function b(input) { await store.set(1, 2) }',
      ]) {
        expect(check(code), code).toHaveLength(1)
      }
    })

    it('does not take a parameter\'s type for a name', () => {
      expect(check('export async function a(m: Map<string, Item>) { return m }\nexport async function b(k) { const seen = new Map(); seen.set(k, 1) }')).toHaveLength(0)
      expect(check('export async function a(x: Set<Item>) { return x }\nconst Item = 1\nexport async function b(k) { const seen = new Set<string>(); seen.delete(k) }')).toHaveLength(0)
    })

    it('does not take a class of that name for the built-in', () => {
      for (const code of [
        "import Map from '@/models/Map'\nexport async function a(input) {\n  const map = new Map(input)\n  await map.save()\n}",
        "import { KV as Map } from './kv'\nexport async function a(input) {\n  const m = new Map()\n  await m.set('a', input)\n}",
        "class Map { set() {} }\nexport async function a(input) {\n  const m = new Map()\n  await m.set('a', input)\n}",
        "export async function a(input) {\n  const m = new SuperMap()\n  await m.set('a', input)\n}",
        "export async function a(input) {\n  const m = new MapStore()\n  await m.set('a', input)\n}",
      ]) {
        expect(check(code), code).toHaveLength(1)
      }
    })

    it('does not take an annotation of that name for the built-in', () => {
      for (const code of [
        "import type { Response } from '@/models/response'\nexport async function run(r: Response) { await r.save() }",
        "import { Map } from '@/models/map'\nexport async function run(m: Map, input) { await m.update(input) }",
        "import type { Headers } from './db'\nexport async function run(h: Headers) { await h.set('a', 'b') }",
        "type Headers = { set(a: string): void }\nexport async function run(h: Headers) { await h.set('a') }",
        "interface Headers { set(a: string): void }\nexport async function run(h: Headers) { await h.set('a') }",
        "class Headers { set(a) {} }\nexport async function run(h: Headers) { await h.set('a') }",
      ]) {
        expect(check(code), code).toHaveLength(1)
      }
    })

    // A built-in has only these two of the methods that read as writes
    it('reads only set() and delete() on a built-in', () => {
      for (const code of [
        'export async function run(r: Response) { await r.save() }',
        'export async function run(input) {\n  const m = new Map()\n  await m.update(input)\n}',
        'export async function run(input) {\n  const r = new Request(input)\n  await r.create(input)\n}',
      ]) {
        expect(check(code), code).toHaveLength(1)
      }
    })

    it('does not take a function of that name for the real one', () => {
      for (const code of [
        "const cookies = () => db.collection('prefs')\nexport async function a(input) { await cookies().delete(input.id) }",
        "function cookies() { return db }\nexport async function a(input) { await cookies().set(input) }",
        "export async function a(input) { await db.cookies().set(input) }",
        "import { db as cookies } from './db'\nexport async function a(input) { await cookies().set('theme', input) }",
        "import { cookies } from './db'\nexport async function a(input) { await cookies().set('theme', input) }",
        "import { createHash } from './db'\nexport async function a(input) { await createHash(input).update(input) }",
        "export async function a(input) { await db.createHash(input).update(input) }",
        "export async function a(input) { await createHashTable(input).update(input) }",
        "export async function a(input) { await myCookies().set(input) }",
        "export async function a(input) { await cookiesStore().set(input) }",
      ]) {
        expect(check(code), code).toHaveLength(1)
      }
      // The real ones, however they're imported or renamed
      for (const code of [
        "import { createHash } from 'crypto'\nconst make = createHash\nexport async function a(input) { return make('md5').update(input).digest('hex') }",
        "import { getMutableAIState as $get } from '@ai-sdk/rsc'\nconst getState = $get<AI>\nexport async function a(input) { const s = getState(); s.update(input) }",
        "import { cookies } from 'next/headers'\nexport async function a(input) { (await cookies()).set('theme', input) }",
        "import { createHash } from 'crypto'\nexport async function a(input) { return createHash('md5').update(input).digest('hex') }",
        "import { createHash } from 'node:crypto'\nexport async function a(input) { return createHash('md5').update(input).digest('hex') }",
        "import crypto from 'crypto'\nexport async function a(input) { return crypto.createHash('md5').update(input).digest('hex') }",
        "import * as nodeCrypto from 'node:crypto'\nexport async function a(input) { return nodeCrypto.createHmac('md5', input).update(input).digest('hex') }",
      ]) {
        expect(check(code), code).toHaveLength(0)
      }
    })

    it('does not take a record for a client factory', () => {
      expect(check("import { Asset as axios } from '@/models'\nexport async function a(input) { await axios.create({ data: input }) }")).toHaveLength(1)
      expect(check("const axios = db.assets\nexport async function a(input) { await axios.create({ data: input }) }")).toHaveLength(1)
      expect(check("import http from 'axios'\nexport async function a(input) { return http.create({ baseURL: input }) }")).toHaveLength(0)
      expect(check("import axios from 'axios'\nexport async function a(input) { return axios.create({ baseURL: input }) }")).toHaveLength(0)
      expect(check("export async function a(Object, input) { await Object.create(input) }")).toHaveLength(1)
    })

    it('does not take any .headers for a response\'s', () => {
      for (const body of [
        'const args = { where: { id: input.id } }\n  await prisma.headers.delete(args)',
        'await prisma.headers.delete({ where: { id: input.id } } as any)',
        'await kv.headers.set(input.key, input.value)',
        'await db.searchParams.delete(input)',
        'await prisma.cookies.delete(input)',
        'await db.cookies.set(input)',
        'await res.headers.update(input)',
        'await response.cookies.save(input)',
      ]) {
        expect(check(action(body)), body).toHaveLength(1)
      }
      for (const body of [
        "const res = NextResponse.next()\n  res.headers.set('a', input)",
        "response.headers.delete('a')",
        "requestInfo.response.headers.set('a', input)",
        "res.cookies.set('a', input)",
        "res.cookies.set({ name: 'a', value: input })",
        "response.cookies.delete('a')",
        "const target = new URL(input)\n  target.searchParams.delete('a')",
        "redirectUrl.searchParams.set('a', input)",
        "request.nextUrl.searchParams.delete('a')",
      ]) {
        expect(check(action(body)), body).toHaveLength(0)
      }
    })
  })

  it('reads a parameter by its type', () => {
    for (const body of ["formData.delete('$ACTION_ID')\n  formData.set('a', 'b')"]) {
      expect(check(`export async function run(formData: FormData) {\n  ${body}\n}`), body).toHaveLength(0)
    }
    expect(check("export async function run(seen: Map<string, number>) { seen.set('a', 1) }")).toHaveLength(0)
    expect(check("export async function run(params: URLSearchParams) { params.delete('a') }")).toHaveLength(0)
    expect(check("export async function run(headers: Headers) { headers.set('a', 'b') }")).toHaveLength(0)
    expect(check("export async function run(store: Store) { await store.set('a', 'b') }")).toHaveLength(1)
    expect(check("export async function run(store) { await store.set('a', 'b') }")).toHaveLength(1)
  })

  it('reads any typed array', () => {
    for (const name of ['Uint8Array', 'Int16Array', 'Float32Array', 'BigInt64Array', 'Uint8ClampedArray']) {
      expect(check(action(`const bytes = new ${name}(8)\n  bytes.set(input)`)), name).toHaveLength(0)
    }
  })

  it('reads optional chaining like the plain call', () => {
    for (const body of ['await db?.update(items).set(input)', 'await kv?.set(input.key, input.value)', 'await kv?.cache?.set?.(input.key, input.value)', 'await prisma.item?.create({ data: input })']) {
      expect(check(action(body)), body).toHaveLength(1)
    }
    for (const body of ["const store = await cookies()\n  store?.set('a', input)", 'const seen = new Map()\n  seen?.set(input, 1)', "res.headers?.set('a', input)", 'const stream = createStreamableValue()\n  stream?.update(input)']) {
      expect(check(action(body)), body).toHaveLength(0)
    }
  })

  describe('with SQL words', () => {
    it('reads a statement in a string as a write', () => {
      for (const body of [
        "await db.query('INSERT INTO items VALUES (1)')",
        "await db.query('INSERT OR REPLACE INTO items VALUES (1)')",
        "await db.query('DELETE FROM items')",
        "await db.query('UPDATE items SET a = 1')",
        'await sql`UPDATE ${table} SET a = 1`',
        "await db.query('UPDATE ' + table + ' SET a = 1')",
        'await db.query(`\n    UPDATE items\n    SET a = 1\n  `)',
      ]) {
        const findings = check(action(body))
        expect(findings, body).toHaveLength(1)
        expect(findings[0].message, body).toContain('performs mutations')
      }
    })

    it('reads a statement put together with +', () => {
      expect(check(action("const q = 'UPDATE ' + input.table + ' SET a = 1'\n  return q"))).toHaveLength(1)
      expect(check(action("const q = 'DELETE ' + 'FROM ' + input.table\n  return q"))).toHaveLength(1)
      expect(check(action("const q = `UPDATE ${input.table} SET a = 1`\n  return q"))).toHaveLength(1)
      expect(check(action("const q = input.a + input.b\n  return q"))).toHaveLength(0)
    })

    it('does not take a word for a statement', () => {
      for (const code of [
        "type Op = 'READ' | 'UPDATE'\nexport async function run(op: Op) { return op }",
        "type Op = 'INSERT' | 'UPDATE' | 'SET'\nexport async function run(op: Op) { return op }",
        "const OPS = { UPDATE: 1, SET: 2 }\nexport async function run(op) { return OPS[op] }",
        "const OPS = { DELETE: 1, FROM: 2 }\nexport async function run(op) { return OPS[op] }",
        "export async function run(op) { return op === 'UPDATE' ? 'SET' : 'GET' }",
        "const a = 'UPDATE'\nconst b = 'SET'\nexport async function run() { return a + b }",
        "export async function run() { return 'UPDATE: the new plans are live' }",
        "export async function run(input) { return input.kind === 'DELETE' ? 1 : 2 }",
        "export const DELETE = 'delete'\nexport async function run() { return DELETE }",
      ]) {
        expect(check(code), code).toHaveLength(0)
      }
    })

    it('keeps the finding of a file that shows a write next to the word', () => {
      for (const body of ["await fetch(url, { method: 'DELETE' })", "await request('DELETE', url)", "await run('UPDATE')\n  await updateRow(input)"]) {
        expect(check(action(body)), body).toHaveLength(1)
      }
    })
  })

  // A comment is no check, and "author" isn't auth
  describe('with what looks like an auth check', () => {
    it('does not read a comment as one', () => {
      for (const comment of ['// const session = await auth()', '// TODO: put getServerSession() back', '/* await requireAuth() */']) {
        expect(check(action(`${comment}\n  await db.delete(items)`)), comment).toHaveLength(1)
      }
      const model = check(`import { generateText } from 'ai'\n${action('// TODO: put getServerSession() back\n  return generateText({ model, prompt: input })')}`)
      expect(model).toHaveLength(1)
      expect(model[0].message).toContain('calls an AI model')
    })

    it('does not read an author as one', () => {
      expect(check(action("cookies().set('a', input)\n  await prisma.post.create({ data: { authorId: input.id } })"))).toHaveLength(1)
      expect(check(action("cookies().set('a', input)\n  await prisma.post.create({ data: { author: input.id } })"))).toHaveLength(1)
      for (const field of ['authorName', 'authorEmail', 'authorSlug', 'authorUrl', 'authority', 'authored']) {
        expect(check(action(`cookies().set('a', input)\n  await prisma.post.create({ data: { ${field}: input.id } })`)), field).toHaveLength(1)
      }
    })

    it('still reads what an author word is not', () => {
      for (const word of ['authorization', 'authorize(input)', 'authorized', 'auth_token']) {
        expect(check(action(`cookies().set('a', input)\n  const x = ${word}\n  await db.delete(items)`)), word).toHaveLength(0)
      }
    })

    it('still reads the real ones', () => {
      for (const check_ of ["const token = cookies().get('auth-token')", "const store = cookies()\n  const token = store.get('auth')", "const session = await auth()"]) {
        expect(check(action(`${check_}\n  await db.delete(items)`)), check_).toHaveLength(0)
      }
    })

    it('leaves a file Babel can\'t parse to the text', () => {
      const file = makeFile(`'use server'\n${action('// const session = await auth()\n  await db.delete(items)')}\n`, { relativePath: 'app/actions/items.ts', withAst: false })
      expect(serverActionAuthRule.check(file, project)).toHaveLength(0)
    })
  })

  // A generated file mustn't end the scan, or stall it
  describe('with a very long file', () => {
    it('survives a long chain of aliases', () => {
      const aliases = Array.from({ length: 3000 }, (_, i) => `const a${i} = a${i + 1}`).join('\n')
      expect(() => check(`${aliases}\nconst a3000 = new Map()\nexport async function run(input) { await a0.set(input, 1) }`)).not.toThrow()
      expect(check(`${aliases}\nconst a3000 = db.items\nexport async function run(input) { await a0.set(input, 1) }`)).toHaveLength(1)
    })

    it('does not stall on names that fan out', () => {
      const lines = ['let v0 = new Map()']
      for (let i = 1; i <= 40; i++) lines.push(`let v${i} = v${i - 1}`, `v${i} = v${i - 1}`)
      expect(check(`export async function run(input) {\n${lines.join('\n')}\nv40.set(input, 1)\n}`)).toHaveLength(0)
    })

    it('survives a client defined through a long chain', () => {
      const aliases = Array.from({ length: 20000 }, (_, i) => `const a${i} = a${i + 1}`).join('\n')
      expect(() => check(`${aliases}\nconst a20000 = actionClient\nexport const run = a0.action(async () => { await db.delete(items) })`)).not.toThrow()
    })

    it('does not stall on many exports', () => {
      const exports = Array.from({ length: 3000 }, (_, i) => `export const a${i} = authActionClient.action(async () => { await db.delete(items) })`).join('\n')
      expect(check(`${exports}\nexport async function b(input) { return input }`)).toHaveLength(0)
    })
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
      const local = 'export async function a(input) {\n  const store = new Map()\n  store.set(input, 1)\n}'
      for (const params of ['store, input', '{ store }, input', 'input, ...store', 'input, store = kv', '[store], input']) {
        expect(check(`${local}
export async function b(${params}) {
  await store.set(input.id, input)
}`), params).toHaveLength(1)
      }
      // So does a name it destructures
      expect(check(`${local}
export async function b(input) {
  const { store } = await open(input)
  await store.set(input.id, input)
}`)).toHaveLength(1)
      // A client in one function isn't a client in the next
      const findings = check(`import OpenAI from 'openai'
export async function a(input) {
  const client = new OpenAI()
  return client.models.list()
}
export async function b(input) {
  const client = db.items
  return client.create({ data: input })
}`)
      expect(findings).toHaveLength(1)
      expect(findings[0].message).toContain('performs mutations')
      // A type import is no value
      expect(check(`import type { store } from './types'\n${local}`)).toHaveLength(0)
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
    expect(check(action(SDK, CALL), project, 'tests/actions/ai.ts')).toHaveLength(0)
    // ...and a checked action's model call doesn't count against a neighbor
    expect(check(`${SDK}
export const a = authActionClient.action(async ({ parsedInput }) => generateText({ model, prompt: parsedInput }))
export async function b(input) { return input }`)).toHaveLength(0)
    expect(check(`${SDK}
export const a = authActionClient.action(async () => 1)
export async function b(input) { return generateText({ model, prompt: input }) }`)).toHaveLength(1)
  })

  // Anyone can still call it, but the bill has a limit: what a public action needs. So a limit
  // is a call on the action's path, not a word in the file.
  describe('with a rate limit', () => {
    it('accepts one in place of an auth check', () => {
      for (const limit of [
        'const { success } = await ratelimit.limit(ip)\n  if (!success) throw new Error("Too many requests")',
        'await checkRateLimit(ip)',
        'await rateLimit(ip)',
        'await enforceRateLimiter(ip)',
        'await limiter.limit(ip)',
        'await limiter.consume(ip)',
        'await rateLimiter.removeTokens(1)',
        "const { success } = await Upstash.slidingWindow(5, '1 m')",
        'const rl = new Ratelimit({ redis })\n  await rl.limit(ip)',
        // A check that decides, outside a catch
        "if (await isRateLimited(ip)) throw new Error('slow down')",
        'await limiter(ip)',
        'await rateLimitByIp(ip)',
        'await checkRateLimitByIp(ip)',
        'await enforceRateLimitForUser(input)',
        'const rl = getLimiter()\n  await rl.limit(ip)',
      ]) {
        expect(check(action(SDK, `${limit}\n  ${CALL}`)), limit).toHaveLength(0)
      }
    })

    it('accepts one in the chain, or in a helper on the way', () => {
      expect(check(`${SDK}\nexport const run = actionClient.use(rateLimitMiddleware).action(async ({ parsedInput }) => generateText({ model, prompt: parsedInput }))`)).toHaveLength(0)
      expect(check(`${SDK}\nexport const run = withRateLimit(async (input) => generateText({ model, prompt: input }))`)).toHaveLength(0)
      expect(check(`${SDK}\nexport async function run(input) { return rateLimiter(async () => generateText({ model, prompt: input })) }`)).toHaveLength(0)
      expect(check(`${SDK}\nasync function guard(ip) { await rateLimit(ip) }\nexport async function run(input, ip) {\n  await guard(ip)\n  return generateText({ model, prompt: input })\n}`)).toHaveLength(0)
    })

    it('does not take a word for one', () => {
      for (const [setup, body] of [
        // The provider's own limit
        [`import OpenAI from 'openai'`, `try {\n    return await openai.chat.completions.create({ model: name, messages: input })\n  } catch (e) {\n    if (e instanceof OpenAI.RateLimitError) return null\n    throw e\n  }`],
        [SDK, `try {\n    return await generateText({ model, prompt: input })\n  } catch (e) {\n    if (isRateLimitError(e)) return null\n    throw new RateLimitError('slow down')\n  }`],
        [SDK, `if (e.code === 'rate_limit_exceeded') return null\n  ${CALL}`],
        // The provider's limit again, read after the call
        [SDK, `try {\n    return await generateText({ model, prompt: input })\n  } catch (e) {\n    if (isRateLimited(e)) return null\n    throw e\n  }`],
        [SDK, 'return retryOnRateLimit(() => generateText({ model, prompt: input }))'],
        [SDK, 'const r = await generateText({ model, prompt: input })\n  logRateLimit(r.response)\n  return r'],
        [SDK, 'const r = await generateText({ model, prompt: input })\n  parseRateLimit(r.response)\n  return r'],
        [SDK, 'const r = await generateText({ model, prompt: input })\n  handleRateLimit(r.response)\n  return r'],
        // Reading one, or resetting it, limits nothing
        [SDK, `const key = rateLimitKey(input)\n  ${CALL}`],
        [SDK, `const current = getRateLimit(input)\n  ${CALL}`],
        [SDK, `resetRateLimit(input)\n  ${CALL}`],
        [SDK, `setRateLimit(input)\n  ${CALL}`],
        [SDK, `const over = rateLimitExceeded(input)\n  ${CALL}`],
        // A cap on concurrency: every caller still gets through
        [`${SDK}\nimport pLimit from 'p-limit'`, 'const limiter = pLimit(2)\n  return limiter(() => generateText({ model, prompt: input }))'],
        // lodash's, which paces a stream
        [`import { streamText } from 'ai'\nimport { throttle } from 'lodash'`, `const stream = createStreamableValue()\n  const send = throttle((t) => stream.update(t), 100)\n  for await (const t of streamText({ model, prompt: input }).textStream) send(t)`],
        // "generate" ends in "rate"
        [SDK, `const generateLimit = 5\n  ${CALL}`],
        // A query's limit
        [SDK, `const rows = await db.select().from(items).limit(5)\n  return generateText({ model, prompt: rows })`],
        // A comment or a string limits nothing
        [SDK, `// await rateLimit(ip)\n  ${CALL}`],
        [SDK, `// TODO: rateLimit this\n  ${CALL}`],
        [SDK, `const note = 'rateLimit(ip) goes here'\n  ${CALL}`],
        // Set up, never called
        [`${SDK}\nimport { Ratelimit } from '@upstash/ratelimit'`, CALL],
      ]) {
        const findings = check(action(setup, body))
        expect(findings, body).toHaveLength(1)
        expect(findings[0].message, body).toContain('calls an AI model')
      }
    })

    it("does not take a neighbor's for its own", () => {
      expect(check(`${SDK}
export async function a(ip) { await rateLimit(ip) }
export async function b(input) { return generateText({ model, prompt: input }) }`)).toHaveLength(1)
      expect(check(`${SDK}
export const a = authActionClient.action(async () => { await rateLimit(ip) })
export async function b(input) { return generateText({ model, prompt: input }) }`)).toHaveLength(1)
      // Every action that calls the model needs one
      expect(check(`${SDK}
export async function a(input, ip) { await rateLimit(ip); return generateText({ model, prompt: input }) }
export async function b(input) { return generateText({ model, prompt: input }) }`)).toHaveLength(1)
      expect(check(`${SDK}
export async function a(input, ip) { await rateLimit(ip); return generateText({ model, prompt: input }) }
export async function b(input, ip) { await limiter.limit(ip); return generateText({ model, prompt: input }) }`)).toHaveLength(0)
    })

    it('is no check on a write', () => {
      const findings = check(action(SDK, 'await ratelimit.limit(ip)\n  await prisma.note.create({ data: input })'))
      expect(findings).toHaveLength(1)
      expect(findings[0].message).toContain('performs mutations')
    })

    // It may not cover this action, so it lowers the severity, the way auth middleware does
    it('rates it info when the middleware rate-limits', () => {
      const proj = makeProject({ hasRateLimiting: true, rateLimitsInMiddleware: true })
      const findings = check(action(SDK, CALL), proj)
      expect(findings).toHaveLength(1)
      expect(findings[0].severity).toBe('info')
      expect(findings[0].message).toContain('rate limiting detected')
      // ...and leaves a write alone
      expect(check(action(SDK, 'await prisma.note.create({ data: input })'), proj).map(f => f.severity)).toEqual(['warning'])
    })

    it('rates a public action info when the middleware rate-limits', () => {
      const proj = makeProject({ hasRateLimiting: true, rateLimitsInMiddleware: true })
      const findings = check(action(SDK, CALL), proj, 'app/actions/feedback.ts')
      expect(findings.map(f => f.severity)).toEqual(['info'])
      expect(findings[0].message).toContain('rate limiting detected')
    })

    // Having the package says nothing about this action
    it('does not rate it lower for a rate-limiting dependency', () => {
      const findings = check(action(SDK, CALL), makeProject({ hasRateLimiting: true }))
      expect(findings.map(f => f.severity)).toEqual(['warning'])
      expect(findings[0].message).toContain('anyone can call this action')
    })

    it('reads the middleware through the scanner', async () => {
      const severities = async (files: Record<string, string>) =>
        (await scanFiles(files)).findings.filter(f => f.ruleId === 'server-action-auth').map(f => f.severity)
      const ask = { 'app/actions/ask.ts': `'use server'\n${action(SDK, CALL)}\n` }
      expect(await severities(ask)).toEqual(['warning'])
      expect(await severities({ ...ask, 'middleware.ts': "import { rateLimit } from './limit'\nexport default async function middleware(req) { return rateLimit(req) }\n" })).toEqual(['info'])
      expect(await severities({ ...ask, 'package.json': JSON.stringify({ name: 'app', dependencies: { '@upstash/ratelimit': '1.0.0', next: '16.0.0' } }) })).toEqual(['warning'])
      expect(await severities({ ...ask, 'proxy.ts': 'export async function proxy(req) { const { success } = await limiter.limit(req.ip); return success }\n' })).toEqual(['info'])
      expect(await severities({ ...ask, 'src/middleware.ts': 'export async function middleware(req) { return checkRateLimit(req) }\n' })).toEqual(['info'])
    })

    // A comment, lodash's throttle() or a matcher that never runs on an action: none covers it
    it('does not read the middleware as covering what it can\'t', async () => {
      const findings = async (files: Record<string, string>) =>
        (await scanFiles(files)).findings.filter(f => f.ruleId === 'server-action-auth')
      const ask = { 'app/actions/ask.ts': `'use server'\n${action(SDK, CALL)}\n` }
      for (const middleware of [
        '// TODO: rateLimit here\nexport function middleware() {}\n',
        "const note = 'rateLimit(req)'\nexport function middleware() { return note }\n",
        'export function middleware(req) { return throttle(req) }\n',
        "export default async function middleware(req) { return rateLimit(req) }\nexport const config = { matcher: ['/api/:path*'] }\n",
      ]) {
        const [finding] = await findings({ ...ask, 'middleware.ts': middleware })
        expect(finding?.severity, middleware).toBe('warning')
        expect(finding?.message, middleware).not.toContain('rate limiting detected')
      }
      // With auth in the same middleware, the message says why it doesn't cover the action
      const [auth] = await findings({ ...ask, 'middleware.ts': "import { clerkMiddleware } from '@clerk/nextjs/server'\nexport default clerkMiddleware(async (a, r) => { await rateLimit(r) })\nexport const config = { matcher: ['/api/:path*'] }\n" })
      expect(auth.severity).toBe('warning')
      expect(auth.message).toContain("matcher doesn't cover pages")
    })
  })

  it('says so in the fix for each kind of finding', () => {
    expect(check(action(SDK, CALL))[0].fix).toContain('rate-limit')
    expect(check(action(SDK, CALL), makeProject({ hasAuthMiddleware: true }))[0].fix).toContain('rate-limit')
    expect(check(action(SDK, CALL), makeProject({ hasAuthMiddleware: true, authMiddlewareExcludesPages: true }))[0].fix).toContain('rate-limit')
    expect(check(action(SDK, 'await prisma.note.create({ data: input })'), makeProject({ hasAuthMiddleware: true }))[0].fix).not.toContain('rate-limit')
  })

  it('reads a call however the SDK got here', () => {
    for (const [setup, body] of [
      ["import * as ai from 'ai'", 'return ai.streamText({ model, prompt: input })'],
      ["import * as rsc from '@ai-sdk/rsc'", 'return rsc.streamUI({ model, prompt: input })'],
      ['', "const { streamText } = await import('ai')\n  return streamText({ model, prompt: input })"],
      ["import { streamText } from 'ai'", 'return (streamText as any)({ model, prompt: input })'],
      ["import { streamText } from 'ai'", 'return streamText!({ model, prompt: input })'],
    ]) {
      const findings = check(action(setup, body))
      expect(findings, body).toHaveLength(1)
      expect(findings[0].message, body).toContain('calls an AI model')
    }
  })

  it('reads the clients of other providers', () => {
    for (const [setup, make] of [
      ["import OpenAI from 'openai'", 'new OpenAI()'],
      ["import { AzureOpenAI } from 'openai'", 'new AzureOpenAI()'],
      ["import { Mistral } from '@mistralai/mistralai'", 'new Mistral()'],
      ["import { CohereClient } from 'cohere-ai'", 'new CohereClient()'],
      ["import Groq from 'groq-sdk'", 'new Groq()'],
      ["import Replicate from 'replicate'", 'new Replicate()'],
      ["import { HfInference } from '@huggingface/inference'", 'new HfInference()'],
      ["import { Ollama } from 'ollama'", 'new Ollama()'],
      ["import { BedrockRuntimeClient } from '@aws-sdk/client-bedrock-runtime'", 'new BedrockRuntimeClient({})'],
      ["import { ChatGroq } from '@langchain/groq'", 'new ChatGroq({})'],
      ["import * as sdk from 'openai'", 'new sdk.OpenAI()'],
    ]) {
      const findings = check(action(setup, `const client = ${make}\n  return client.ask(input)`))
      expect(findings, setup).toHaveLength(1)
      expect(findings[0].message, setup).toContain('calls an AI model')
    }
  })

  // createStreamableValue() and getMutableAIState() are the AI SDK's, but neither calls a model
  it('does not take a stream or AI state for a model call', () => {
    for (const [setup, body] of [
      ["import { getMutableAIState } from 'ai/rsc'", 'const aiState = getMutableAIState()\n  aiState.done({ ...aiState.get(), input })'],
      ["import { createStreamableValue } from 'ai/rsc'", 'const progress = createStreamableValue(0)\n  progress.done(100)\n  return progress.value'],
      ["import { createStreamableUI } from '@ai-sdk/rsc'", 'const ui = createStreamableUI()\n  ui.update(input)\n  return ui.value'],
      ["import { getMutableAIState } from 'ai/rsc'", 'const state = getMutableAIState()\n  state.update(input)'],
    ]) {
      expect(check(action(setup, body)), body).toHaveLength(0)
    }
  })

  // A model behind a helper is out of sight, but the helper isn't shown harmless, so the file
  // stays as reported as it was
  it('keeps the finding of a stream fed by a helper it can\'t read', () => {
    const findings = check(action("import { createStreamableValue } from 'ai/rsc'\nimport { ask } from './model'", 'const stream = createStreamableValue()\n  for await (const t of ask(input)) stream.update(t)\n  stream.done()\n  return stream.value'))
    expect(findings).toHaveLength(1)
    expect(findings[0].message).toContain('performs mutations')
  })

  // What's kept is a guess, and the model call is a fact, so that's the message. A limit clears
  // the model call, not the guess, and middleware that limits doesn't lower it.
  it('says model call over a kept finding', () => {
    const body = 'const stream = createStreamableValue()\n  for await (const t of ask(input)) stream.update(t)\n  return generateText({ model, prompt: input })'
    const setup = `${SDK}\nimport { createStreamableValue } from 'ai/rsc'\nimport { ask } from './model'`
    expect(check(action(setup, body))[0].message).toContain('calls an AI model')
    expect(check(action(setup, `await rateLimit(ip)\n  ${body}`))[0].message).toContain('performs mutations')
    const limited = check(action(setup, body), { ...project, rateLimitsInMiddleware: true })
    expect(limited[0].severity).toBe('warning')
    expect(limited[0].message).toContain('calls an AI model')
    const plain = check(action(SDK, CALL), { ...project, rateLimitsInMiddleware: true })
    expect(plain[0].severity).toBe('info')
  })

  // A limit clears the model call, and what's left of it isn't a guess at a write
  it('leaves a model call out of what keeps a finding', () => {
    const keep = 'await rateLimit(ip)\n  const seen = new Map()\n  seen.set(input, 1)\n  '
    for (const [setup, body] of [
      ['', 'return openai.chat.completions.stream({ model, messages: input })'],
      ["import ollama from 'ollama'", 'return ollama.chat(input)'],
      ["import OpenAI from 'openai'", 'const client = new OpenAI()\n  return client.images.generate(input)'],
    ]) {
      expect(check(action(setup, `${keep}${body}`)), body).toHaveLength(0)
    }
  })

  // A definite write says so whatever else is there
  it('says mutation over a model call', () => {
    expect(check(action(SDK, `await db.item.create({ data: input })\n  ${CALL}`))[0].message).toContain('performs mutations')
    expect(check(action(SDK, `await db.query('DELETE FROM items')\n  ${CALL}`))[0].message).toContain('performs mutations')
  })

  describe('reads where the call is', () => {
    it('follows an action into helpers and clients in the file', () => {
      for (const code of [
        `${SDK}\nconst summarize = (p) => generateText({ model, prompt: p })\nexport async function run(input) { return summarize(input) }`,
        `${SDK}\nfunction summarize(p) { return generateText({ model, prompt: p }) }\nfunction outer(p) { return summarize(p) }\nexport async function run(input) { return outer(input) }`,
        `import OpenAI from 'openai'\nconst client = new OpenAI()\nexport async function run(input) { return client.models.list() }`,
        `${SDK}\nconst run = async (input) => generateText({ model, prompt: input })\nexport { run }`,
        `${SDK}\nexport default async function run(input) { return generateText({ model, prompt: input }) }`,
        `${SDK}\nexport const run = actionClient.action(async ({ parsedInput }) => generateText({ model, prompt: parsedInput }))`,
      ]) {
        expect(check(code), code).toHaveLength(1)
      }
    })

    it('leaves out what only a checked action reaches', () => {
      for (const code of [
        `import OpenAI from 'openai'\nconst openai = new OpenAI()\nexport const ask = authActionClient.action(async ({ parsedInput }) => openai.models.list(parsedInput))\nexport async function ping() { return 1 }`,
        `${SDK}\nconst summarize = (p) => generateText({ model, prompt: p })\nexport const ask = authActionClient.action(async ({ parsedInput }) => summarize(parsedInput))\nexport async function ping() { return 1 }`,
      ]) {
        expect(check(code), code).toHaveLength(0)
      }
    })

    it('leaves out what no action reaches', () => {
      expect(check(`${SDK}\nasync function unused(p) { return generateText({ model, prompt: p }) }\nexport async function ping() { return 1 }`)).toHaveLength(0)
    })

    it('reads only the action when the directive is inside it', () => {
      const file = (code: string) => makeFile(code, { relativePath: 'app/page.tsx' })
      // The page calls the model while rendering, and its action does something else
      expect(serverActionAuthRule.check(file(`import { generateText } from 'ai'
import { revalidatePath } from 'next/cache'
export default async function Page() {
  const { text } = await generateText({ model, prompt: 'Tip of the day' })
  async function refresh() {
    'use server'
    revalidatePath('/')
  }
  return <form action={refresh}><p>{text}</p></form>
}`), project)).toHaveLength(0)
      const inside = serverActionAuthRule.check(file(`import { generateText } from 'ai'
export default async function Page() {
  async function ask(formData) {
    'use server'
    return generateText({ model, prompt: formData.get('q') })
  }
  return <form action={ask} />
}`), project)
      expect(inside).toHaveLength(1)
      expect(inside[0].message).toContain('calls an AI model')
      expect(inside[0].line).toBe(4)
    })

    it('does not take a parameter for the import it hides', () => {
      expect(check(`${SDK}\nexport async function run(generateText, input) { return generateText(input) }`)).toHaveLength(0)
      expect(check(`import { embed } from 'ai'\nexport async function run(rows) { return rows.map(embed => embed.id) }`)).toHaveLength(0)
      expect(check(`import { embed } from 'ai'\nexport async function run(rows) {\n  function local(embed) { return embed(rows) }\n  return local(x => x)\n}`)).toHaveLength(0)
    })

    it('does not take an error class for a client', () => {
      expect(check(`import { OpenAIError } from 'openai'\nexport async function run(input) { if (!input) throw new OpenAIError('missing'); return input }`)).toHaveLength(0)
      expect(check(`import { GoogleGenerativeAIError } from '@google/generative-ai'\nexport async function run(input) { if (!input) throw new GoogleGenerativeAIError('missing'); return input }`)).toHaveLength(0)
    })
  })

  // No auth needed doesn't make the model free: there's nobody to check, so it needs a limit
  describe('in an action that is public by design', () => {
    const PUBLIC = 'Server action calls an AI model with no rate limit — anyone can call this public action and spend your credits'
    const GUARDED = (body: string) => `${SDK}\nexport const run = actionClient.use(throwIfAuthenticated).action(async ({ parsedInput }) => ${body})`

    it('reports a model call behind a guest guard', () => {
      for (const code of [
        GUARDED('generateText({ model, prompt: parsedInput })'),
        GUARDED('openai.chat.completions.create({ model: name, messages: parsedInput })'),
      ]) {
        const findings = check(code)
        expect(findings, code).toHaveLength(1)
        expect(findings[0].message).toBe(PUBLIC)
        expect(findings[0].severity).toBe('warning')
        expect(findings[0].fix).toContain('Rate-limit')
        expect(findings[0].fix).not.toContain('auth()')
      }
      expect(check(`${SDK}\nexport const run = actionClient.use(throwIfAuthenticated).use(rateLimit).action(async ({ parsedInput }) => generateText({ model, prompt: parsedInput }))`)).toHaveLength(0)
    })

    it('reports a model call on a public-named path', () => {
      for (const path of ['app/actions/feedback.ts', 'app/actions/contact.ts', 'app/signup/actions.ts']) {
        const findings = check(action(SDK, CALL), project, path)
        expect(findings, path).toHaveLength(1)
        expect(findings[0].message).toBe(PUBLIC)
      }
      expect(check(action(SDK, `await rateLimit(ip)\n  ${CALL}`), project, 'app/actions/feedback.ts')).toHaveLength(0)
      // A write there is still fine, as before
      expect(check(action(SDK, 'await prisma.note.create({ data: input })'), project, 'app/actions/feedback.ts')).toHaveLength(0)
    })

    it('still asks for a check where one could go', () => {
      const findings = check(`${SDK}
export const a = actionClient.use(throwIfAuthenticated).action(async () => 1)
export async function b(input) { return generateText({ model, prompt: input }) }`)
      expect(findings).toHaveLength(1)
      expect(findings[0].message).toContain('without any authentication check')
    })
  })

  it('does not count a model call in a checked action next to a guest guard', () => {
    expect(check(`${SDK}
export const a = authActionClient.action(async ({ parsedInput }) => generateText({ model, prompt: parsedInput }))
export const b = actionClient.use(throwIfAuthenticated).action(async () => 1)`)).toHaveLength(0)
  })

  it('reads any .create() on a client the file makes as a model call', () => {
    for (const [setup, body] of [
      ["import Anthropic from '@anthropic-ai/sdk'", 'const client = new Anthropic()\n  return client.messages.create({ model: name, messages: input })'],
      ["import OpenAI from 'openai'", 'const client = new OpenAI()\n  return client.responses.create({ model: name, input })'],
      ["import OpenAI from 'openai'", 'const client = new OpenAI()\n  return client.embeddings.create({ model: name, input })'],
      ["import OpenAI from 'openai'", 'const client = new OpenAI()\n  return client.beta.threads.create()'],
      // By the client's own name, from anywhere
      ['', 'return openai.responses.create({ model: name, input })'],
      ['', 'return openai.embeddings.create({ model: name, input })'],
      ['', 'return openAI.audio.speech.create({ model: name, input })'],
      ['', 'return anthropic.beta.messages.create({ model: name, messages: input })'],
      ['', 'return groqClient.audio.transcriptions.create({ file: input })'],
    ]) {
      const findings = check(action(setup, body))
      expect(findings, body).toHaveLength(1)
      expect(findings[0].message, body).toContain('calls an AI model')
      expect(check(action(setup, `await rateLimit(ip)\n  ${body}`)), body).toHaveLength(0)
    }
    // A client's other methods, and tables that aren't clients
    for (const body of [
      'return openaiLogs.create({ data: input })',
      'return prisma.openai.create({ data: input })',
      'return anthropic.messages.delete(input.id)',
    ]) {
      const findings = check(action('', body))
      expect(findings, body).toHaveLength(1)
      expect(findings[0].message, body).toContain('performs mutations')
    }
    expect(check(action("import OpenAI from 'openai'", 'const client = new OpenAI()\n  const other = db.items\n  return other.create({ data: input })'))[0].message).toContain('performs mutations')
  })

  // A model of the database, named for what it holds. The file says so, or its capital does.
  it('does not take a name for a client against what the file says', () => {
    for (const [setup, body] of [
      ['', "const Gemini = mongoose.model('Gemini')\n  return Gemini.create(input)"],
      ['', "const gemini = mongoose.model('Gemini')\n  return gemini.create(input)"],
      ['', "const openai = db.collection('openai')\n  return openai.create(input)"],
      ["import { Gemini } from '@/models'", 'return Gemini.create(input)'],
      ["import { Anthropic } from '@/models'", 'return Anthropic.create(input)'],
    ]) {
      for (const limit of ['', 'await rateLimit(input.ip)\n  ']) {
        const findings = check(action(setup, `${limit}${body}`))
        expect(findings, body).toHaveLength(1)
        expect(findings[0].message, body).toContain('performs mutations')
      }
    }
  })

  it('reads the two APIs through optional chaining', () => {
    expect(check(action('', 'return openai?.chat?.completions?.create({ model: name, messages: input })'))[0].message).toContain('calls an AI model')
    expect(check(action('', 'return anthropic?.messages?.create({ model: name, messages: input })'))[0].message).toContain('calls an AI model')
  })

  // A package's other exports are something else
  it('goes by the whole package name', () => {
    for (const setup of ["import { Thing } from 'openai-helpers'", "import { Thing } from '@langchain/core/messages'", "import { Thing } from 'my-ai'"]) {
      expect(check(action(setup, 'return new Thing(input)')), setup).toHaveLength(0)
    }
    expect(check(action("import { generateText } from 'ai-tools'", 'return generateText(input)'))).toHaveLength(0)
    expect(check(action("import { myGenerateText } from 'ai'", 'return myGenerateText(input)'))).toHaveLength(0)
    // Only off a namespace import
    expect(check(action("import { thing } from 'ai'", 'return thing.generateText(input)'))).toHaveLength(0)
  })

  it('survives a file Babel can\'t parse', () => {
    const file = makeFile(`'use server'\n${action(SDK, CALL)}\n`, { relativePath: 'app/actions/ai.ts', withAst: false })
    expect(serverActionAuthRule.check(file, project)).toHaveLength(0)
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

// A request, a file, mail or a command changes something outside the process, and outlives the request.
// These count by themselves, when the file shows all of it, unless it shows it isn't a write. A POST
// that isn't one doesn't keep a finding next to an unrelated push() either.
describe('server-action-auth on what goes out and stays out', () => {
  const check = (code: string, proj = project, relativePath = 'app/actions/items.ts') =>
    serverActionAuthRule.check(makeFile(`'use server'\n${code}\n`, { relativePath }), proj)
  const action = (body: string) => `export async function run(input) {\n  ${body}\n}`
  const NEXT_TO_A_PUSH = 'const rows = []\n  rows.push(input)\n  '
  const AXIOS = "import axios from 'axios'"
  const API = "import { api } from '@/lib/api'"
  const FS = "import fs from 'node:fs/promises'\nimport { join } from 'node:path'\nimport { tmpdir } from 'node:os'"
  const POST = (url: string, rest = 'body: input') => `await fetch(${url}, { method: 'POST', ${rest} })`
  const ORDERS = "'https://api.example.com/orders'"

  const counts = (setup: string, body: string, message: RegExp) => {
    const findings = check(`${setup}\n${action(body)}`)
    expect(findings, body).toHaveLength(1)
    expect(findings[0].severity, body).toBe('warning')
    expect(findings[0].message, body).toMatch(message)
    expect(findings[0].message, body).toContain('anyone can call this action')
    const kept = check(`${setup}\n${action(`${NEXT_TO_A_PUSH}${body}`)}`)
    expect(kept, body).toHaveLength(1)
  }
  // Isn't a write: nothing alone, and nothing next to a push()
  const clears = (setup: string, body: string) => {
    expect(check(`${setup}\n${action(body)}`), body).toHaveLength(0)
    expect(check(`${setup}\n${action(`${NEXT_TO_A_PUSH}${body}`)}`), `next to a push: ${body}`).toHaveLength(0)
  }
  // Can't tell: nothing alone, but it doesn't clear a finding either
  const onlyKeeps = (setup: string, body: string) => {
    expect(check(`${setup}\n${action(body)}`), body).toHaveLength(0)
    expect(check(`${setup}\n${action(`${NEXT_TO_A_PUSH}${body}`)}`), `next to a push: ${body}`).toHaveLength(1)
  }
  const REQUEST = /^Server action sends a write request without any authentication check/
  const FILES = /^Server action writes files without any authentication check/
  const MAIL = /^Server action sends email without any authentication check/
  const CLOUD = /^Server action writes to a cloud service without any authentication check/

  describe('with a request', () => {
    it('counts one the file shows all of', () => {
      for (const body of [
        `await fetch(url, { method: 'POST', body: JSON.stringify(input) })`,
        `await fetch(url, { method: "PUT", body: input })`,
        `await fetch(url, { method: 'PATCH', body: input })`,
        `await fetch(url, { method: 'post', body: input })`,
        `await fetch(url, { method: 'DELETE' })`,
        `await fetch(url, { method: 'delete' })`,
        `const options = { method: 'POST', body: input }\n  await fetch(url, options)`,
        `await fetch(url, { method: input.id ? 'PUT' : 'POST', body: input })`,
        `const method = 'POST'\n  await fetch(url, { method })`,
        `await fetch(url, { 'method': 'POST' })`,
        'await fetch(url, { method: `POST` })',
        `await fetch(new Request(url, { method: 'POST', body: input }))`,
        `await env.API.fetch(url, { method: 'POST', body: input })`,
        `const stub = env.ROOM.get(input)\n  await stub.fetch(url, { method: 'POST', body: input })`,
      ]) {
        counts('', body, REQUEST)
      }
    })

    it('counts one through an HTTP package, or a client the file makes of it', () => {
      for (const [setup, body] of [
        [AXIOS, 'await axios.post(url, input)'],
        [AXIOS, 'await axios.put(url, input)'],
        [AXIOS, 'await axios.patch(url, input)'],
        [AXIOS, 'await axios.delete(url)'],
        [AXIOS, `await axios({ method: 'post', url, data: input })`],
        [AXIOS, `await axios.request({ method: 'POST', url, data: input })`],
        ["import ky from 'ky'", 'await ky.post(url, { json: input })'],
        ["import got from 'got'", 'await got.put(url, { json: input })'],
        ["import fetch from 'node-fetch'", `await fetch(url, { method: 'POST', body: input })`],
        ["import { fetch as send } from 'undici'", `await send(url, { method: 'POST', body: input })`],
        [AXIOS, `const client = axios.create({ baseURL: url })\n  await client.post('/orders', input)`],
        [AXIOS, `const client = axios.create({ baseURL: url })\n  await client.delete('/orders')`],
        ["import ky from 'ky'", `const client = ky.extend({ prefixUrl: url })\n  await client.post('orders', { json: input })`],
      ]) {
        counts(setup, body, REQUEST)
      }
    })

    // Most of the imported clients read on the sample forward the caller's token
    it('does not count one through what it can\'t see', () => {
      for (const [setup, body] of [
        [API, 'await api.post(url, input)'],
        [API, 'await api.put(url, input)'],
        ["import { apiClient } from '@/lib/api'", 'await apiClient.POST(url, input)'],
        ["import { sdk } from '@/lib/sdk'", `await sdk.client.fetch('/store/orders', { method: 'POST', body: input })`],
        ['', `await fetchWithRetry(url, { method: 'POST', body: input })`],
        ["import { makeClient } from './client'", 'const client = makeClient()\n  await client.post(url, input)'],
        ['', 'await axios.post(url, input)'], // Not this package: the file never imports it
      ]) {
        onlyKeeps(setup, body)
      }
    })

    it('does not take a read for one', () => {
      for (const body of [
        'await fetch(url)',
        `await fetch(url, { method: 'GET' })`,
        `await fetch(url, { cache: 'no-store' })`,
        `// await fetch(url, { method: 'POST' })`,
      ]) {
        clears('', body)
      }
      clears(AXIOS, 'await axios.get(url)')
    })

    it('does not take a function of that name for fetch', () => {
      expect(check(`function fetch(a, b) { return a }\n${action(`return fetch(url, { method: 'POST' })`)}`)).toHaveLength(0)
      expect(check(`export async function run(fetch, input) { return fetch(url, { method: 'POST' }) }`)).toHaveLength(0)
    })

    it('reads a client by what made it', () => {
      onlyKeeps("import { foo } from './foo'", 'const client = foo.extend({ prefixUrl: url })\n  await client.post(url, input)')
    })

    it('reads each package\'s arguments where it has them', () => {
      // ky and got take one object of options: their body and headers are in there
      clears("import ky from 'ky'", 'await ky.post(url, { json: input, headers: { Authorization: input.jwt } })')
      clears("import ky from 'ky'", `await ky.post(url, { json: { query: 'query { a }' } })`)
      clears("import ky from 'ky'", `const client = ky.extend({ prefixUrl: url })\n  await client.post('items', { json: input, headers: { Authorization: input.jwt } })`)
      // axios has them separately, and delete() has no data
      clears(AXIOS, `const client = axios.create({ baseURL: url })\n  await client.post('items', input, { headers: { Authorization: input.jwt } })`)
    })
  })

  describe('with a GraphQL query over POST', () => {
    it('does not count a read', () => {
      for (const [setup, body] of [
        ['', POST('url', 'body: JSON.stringify({ query })')],
        ['', POST('url', 'body: JSON.stringify({ query, variables })')],
        ['', POST('url', 'body: JSON.stringify({ query: GET_ITEMS, variables })')],
        ['', POST('url', 'body: JSON.stringify({ query: itemsQuery })')],
        ['', POST('url', 'body: JSON.stringify({ query: SinglePostDocument })')],
        ['', POST('url', 'body: JSON.stringify({ query: `query { items { id } }` })')],
        ['', POST('url', 'body: JSON.stringify({ query: `{ items { id } }` })')],
        ['', "const query = `{ items { id } }`\n  " + POST('url', 'body: JSON.stringify({ query })')],
        ['', "const payload = { query: 'query { a }' }\n  " + POST('url', 'body: JSON.stringify(payload)')],
        ['', POST("'https://api.github.com/graphql'", 'body: input')],
        ['', 'const doc = gql`query { a }`\n  ' + POST('url', 'body: JSON.stringify({ query: doc })')],
        [AXIOS, `await axios.post(url, { query: 'query { a }' })`],
        [AXIOS, `await axios.post('https://leetcode.com/graphql', input)`],
      ]) {
        clears(setup, body)
      }
    })

    it('counts a mutation', () => {
      for (const [setup, body] of [
        ['', POST('url', 'body: JSON.stringify({ query: `mutation { addItem { id } }` })')],
        ['', POST('url', 'body: JSON.stringify({ query: `\n  mutation Add { addItem { id } }` })')],
        ['', POST('url', 'body: JSON.stringify({ query: `# adds one\n  mutation { addItem { id } }` })')],
        ['', POST('url', 'body: JSON.stringify({ query: CREATE_ITEM_MUTATION })')],
        ['', POST('url', 'body: JSON.stringify({ query: createCartMutation })')],
        ['', POST('url', 'body: JSON.stringify({ query: CREATE_ITEM })')],
        ['', POST('url', 'body: JSON.stringify({ query: deleteItem })')],
        ['', "const query = `mutation { a }`\n  " + POST('url', 'body: JSON.stringify({ query })')],
        ['', 'const doc = gql`mutation { a }`\n  ' + POST('url', 'body: JSON.stringify({ query: doc })')],
        [AXIOS, 'await axios.post(url, { query: `mutation { a }` })'],
      ]) {
        counts(setup, body, REQUEST)
      }
    })

    // A helper takes whatever it's given, and this file gives it a mutation
    it('counts a query it can\'t read in a file that has a mutation', () => {
      expect(check("const ADD = `mutation { a }`\nasync function gql(query) { return fetch(url, { method: 'POST', body: JSON.stringify({ query }) }) }\nexport async function run() { return gql(ADD) }")).toHaveLength(1)
      expect(check("async function gql(query) { return fetch(url, { method: 'POST', body: JSON.stringify({ query }) }) }\nexport async function run() { return gql(ADD_ITEM_MUTATION) }")).toHaveLength(1)
      expect(check("const LIST = `query { a }`\nasync function gql(query) { return fetch(url, { method: 'POST', body: JSON.stringify({ query }) }) }\nexport async function run() { return gql(LIST) }")).toHaveLength(0)
      expect(check(`const ADD = 'mutation { a }'\n${action(POST("'https://x.dev/graphql'", 'body: input'))}`)).toHaveLength(1)
    })

    it('reads a query by its own name, whatever else the file has', () => {
      for (const query of ['GET_ITEMS', 'itemsQuery', 'SinglePostDocument']) {
        expect(check(`const ADD = 'mutation { a }'\n${action(POST('url', `body: JSON.stringify({ query: ${query} })`))}`), query).toHaveLength(0)
      }
    })

    it('reads a query by its own text, whatever else the file has', () => {
      expect(check(`const ADD = 'mutation { a }'\n${action('const doc = gql`query { a }`\n  ' + POST('url', 'body: JSON.stringify({ query: doc })'))}`)).toHaveLength(0)
    })
  })

  describe('with a token exchange', () => {
    it('does not count one', () => {
      for (const body of [
        POST('url', `body: new URLSearchParams({ grant_type: 'client_credentials' })`),
        POST('url', `body: 'grant_type=refresh_token&refresh_token=' + input`),
        POST('url', `body: JSON.stringify({ grant_type: 'password' })`),
        POST("'https://accounts.example.com/oauth/token'"),
        POST('TOKEN_ENDPOINT'),
        POST('tokenUrl'),
      ]) {
        clears('', body)
      }
      clears(AXIOS, `await axios.post('https://api.example.com/oauth/access_token', input)`)
    })

    it('counts what only sounds like one', () => {
      counts('', POST(ORDERS, `body: new URLSearchParams({ grant: 'x', type: 'y' })`), REQUEST)
      // What a query string or a parameter says isn't what the URL is for
      counts('', POST('`https://api.example.com/orders?token=${key}`'), REQUEST)
      counts('', POST('`https://api.example.com/invites/${token}/accept`'), REQUEST)
    })
  })

  describe('with a captcha check', () => {
    it('does not count one', () => {
      for (const body of [
        POST("'https://www.google.com/recaptcha/api/siteverify'"),
        POST('`https://www.google.com/recaptcha/api/siteverify?secret=${key}&response=${input}`'),
        POST('RECAPTCHA_VERIFY_URL'),
        POST("'https://challenges.cloudflare.com/turnstile/v0/siteverify'"),
        POST("'https://hcaptcha.com/siteverify'"),
      ]) {
        clears('', body)
      }
      clears(AXIOS, 'await axios.post(`https://www.google.com/recaptcha/api/siteverify?secret=${key}&response=${input}`)')
    })

    it('counts the write next to it', () => {
      counts('', `${POST("'https://hcaptcha.com/siteverify'")}\n  ${POST(ORDERS)}`, REQUEST)
    })
  })

  describe('with a login or register proxy', () => {
    it('does not count one, whatever the client', () => {
      for (const url of ['/auth/login', '/api/logout', '/register', '/users/sign-up', '/users/signin', '/forgot-password', '/reset-password', '/verify-otp', '/api/createAccount', '/auth/user/']) {
        clears('', POST(`\`\${API_URL}${url}\``))
        clears(API, `await api.post('${url}', input)`)
      }
    })

    it('reads the words of a URL, not what it has in it', () => {
      for (const url of ['/orders', '/blogin', '/authors', '/catalog']) {
        counts('', POST(`\`\${API_URL}${url}\``), REQUEST)
      }
    })

    it('leaves an action named for it out of it', () => {
      for (const name of ['login', 'loginUser', 'logout', 'registerUser', 'signUp', 'signIn', 'forgotPassword', 'resetPassword', 'verifyEmail', 'sendOtp', 'verifyCaptcha', 'submitContactForm', 'subscribeToNewsletter', 'joinWaitlist', 'sendFeedback', 'submitLead', 'sendInquiry']) {
        expect(check(`export async function ${name}(input) { ${POST(ORDERS)} }`), name).toHaveLength(0)
        expect(check(`export const ${name} = async (input) => { ${POST(ORDERS)} }`), name).toHaveLength(0)
        expect(check(`const ${name} = async (input) => { ${POST(ORDERS)} }\nexport { ${name} }`), name).toHaveLength(0)
      }
    })

    it('reads each action on its own', () => {
      expect(check(`export async function login(input) { ${POST(ORDERS)} }\nexport async function pay(input) { ${POST(ORDERS)} }`)).toHaveLength(1)
      const helper = `async function send(input) { ${POST(ORDERS)} }\n`
      expect(check(`${helper}export async function login(input) { return send(input) }`)).toHaveLength(0)
      expect(check(`${helper}export async function login(input) { return send(input) }\nexport async function pay(input) { return send(input) }`)).toHaveLength(1)
    })

    it('leaves a path the rule calls public out of it, as it does a write', () => {
      expect(check(action(POST(ORDERS)), project, 'app/contactus/actions.ts')).toHaveLength(0)
    })

    it('leaves a path that says so out of it, and only this', () => {
      for (const path of ['app/(auth)/forgot-password/actions.ts', 'lib/auth/actions.ts', 'actions/verify-email.ts', 'lib/captcha.ts', 'app/enquiries/actions.ts', 'app/waitlist/actions.ts']) {
        expect(check(action(POST(ORDERS)), project, path), path).toHaveLength(0)
        expect(check(action('await prisma.item.create({ data: input })'), project, path), path).toHaveLength(1)
      }
      expect(check(action(POST(ORDERS)), project, 'app/author/actions.ts')).toHaveLength(1)
    })
  })

  describe('with a request that carries the caller\'s token', () => {
    it('does not count one: its backend can check it', () => {
      for (const [setup, body] of [
        ['', `const token = cookies().get('jwt')?.value\n  ${POST('url', 'headers: { Authorization: `Bearer ${token}` }, body: input')}`],
        ['', POST('url', 'headers: { Authorization: `Bearer ${input.jwt}` }, body: input')],
        ['', POST('url', `headers: { Cookie: (await headers()).get('cookie') }, body: input`)],
        ['', POST('url', `headers: { cookie: cookies().toString() }, body: input`)],
        ['', POST('url', `headers: { 'x-access-token': input.jwt }, body: input`)],
        ['', POST('url', `headers: { 'X-Auth-Token': input.jwt }, body: input`)],
        ['', POST('url', 'headers: { token: input.jwt }, body: input')],
        ['', POST('url', 'headers: await getHeaders(), body: input')],
        ['', POST('url', 'headers: input.headers, body: input')],
        ['', POST('url', `headers: { ...getAuthHeaders(), 'Content-Type': 'text/plain' }, body: input`)],
        ['', `const h = new Headers()\n  h.set('Authorization', input.jwt)\n  ${POST('url', 'headers: h, body: input')}`],
        ['', `const h = new Headers()\n  h.append('Cookie', input.jwt)\n  ${POST('url', 'headers: h, body: input')}`],
        ['', `const h = { 'Content-Type': 'text/plain' }\n  h.Authorization = input.jwt\n  ${POST('url', 'headers: h, body: input')}`],
        ['', `const h = {}\n  h['Authorization'] = input.jwt\n  ${POST('url', 'headers: h, body: input')}`],
        ['', POST('url', 'headers: new Headers({ Authorization: input.jwt }), body: input')],
        ['', POST('url', `credentials: 'include', body: input`)],
        ['', POST('url', 'body: JSON.stringify({ token: input.jwt, item: input.item })')],
        [AXIOS, 'await axios.post(url, input, { headers: { Authorization: input.jwt } })'],
        [AXIOS, 'await axios.post(url, input, { withCredentials: true })'],
        [AXIOS, 'await axios.delete(url, { headers: { Authorization: input.jwt } })'],
        [AXIOS, 'const client = axios.create({ headers: { Authorization: input.jwt } })\n  await client.post(url, input)'],
        [AXIOS, 'const client = axios.create({ baseURL: url })\n  client.interceptors.request.use(addToken)\n  await client.post(url, input)'],
        [AXIOS, 'axios.defaults.headers.common.Authorization = input.jwt\n  await axios.post(url, input)'],
      ]) {
        clears(setup, body)
      }
    })

    it('reads a parameter as the caller\'s', () => {
      expect(check(`export async function run(input, jwt) { ${POST('url', 'headers: { Authorization: `Bearer ${jwt}` }, body: input')} }`)).toHaveLength(0)
      expect(check(`export async function run(input, headers) { ${POST('url', 'headers, body: input')} }`)).toHaveLength(0)
    })

    it('reads every value a name stands for', () => {
      const h = (value: string) => `const headers = ${value}\n  ${POST('url', 'headers, body: input')}`
      const two = (a: string, b: string) => `export async function a(input) { ${h(a)} }\nexport async function b(input) { ${h(b)} }`
      expect(check(two(`{ 'Content-Type': 'text/plain' }`, `{ Accept: 'text/plain' }`))).toHaveLength(1)
      expect(check(two(`{ 'Content-Type': 'text/plain' }`, '{ Authorization: input.jwt }'))).toHaveLength(0)
    })

    it('counts one with the server\'s own secret, or nothing that says who\'s calling', () => {
      for (const [setup, body] of [
        ['', POST('url', 'headers: { Authorization: `Bearer ${process.env.API_KEY}` }, body: input')],
        ['', POST('url', 'headers: { Authorization: process.env.API_KEY }, body: input')],
        ['', `const key = process.env.API_KEY\n  ${POST('url', 'headers: { Authorization: `Bearer ${key}` }, body: input')}`],
        ['', `const { API_KEY } = process.env\n  ${POST('url', 'headers: { Authorization: `Bearer ${API_KEY}` }, body: input')}`],
        ['', POST('url', 'headers: { Authorization: `Basic ${Buffer.from(`${process.env.ID}:${process.env.SECRET}`).toString("base64")}` }, body: input')],
        ['', POST('url', `headers: { Authorization: 'Bearer abc' }, body: input`)],
        ['', POST('url', 'headers: { Authorization: `Bearer ${API_KEY}` }, body: input')],
        ["import { env } from '@/env'", POST('url', 'headers: { Authorization: env.API_KEY }, body: input')],
        ['', POST('url', `headers: { 'Content-Type': 'application/json' }, body: input`)],
        ['', POST('url', `headers: { 'x-api-key': input.key }, body: input`)], // Not one of the caller's identity
        ['', `const h = { 'Content-Type': 'text/plain' }\n  ${POST('url', 'headers: h, body: input')}`],
        ['', POST('url', 'body: JSON.stringify({ author: input.name })')], // Not "auth"
        ['', POST('url', 'headers: { authorization: true }, body: input')],
        ['', POST('url', `headers: new Headers({ 'Content-Type': 'text/plain' }), body: input`)],
        ["import { DEFAULT_HEADERS } from '@/lib/http'", POST('url', 'headers: DEFAULT_HEADERS, body: input')],
        ["import { DEFAULT_HEADERS } from '@/lib/http'", POST('url', 'headers: { ...DEFAULT_HEADERS, Accept: "text/plain" }, body: input')],
        // What's sent isn't who's sending it, whatever a parameter holds
        ['', POST('url', 'body: JSON.stringify({ ...input })')],
        ['', POST('url', 'body: JSON.stringify(input)')],
        [AXIOS, 'await axios.post(url, { ...input })'],
        [AXIOS, 'await axios.patch(url, { ...input }, { headers: { Accept: "text/plain" } })'],
        [AXIOS, `await axios.post(url, input, { headers: { 'Content-Type': 'application/json' } })`],
        [AXIOS, 'const client = axios.create({ headers: { Authorization: process.env.API_KEY } })\n  await client.post(url, input)'],
      ]) {
        counts(setup, body, REQUEST)
      }
    })
  })

  describe('with a POST that reads', () => {
    it('does not count one fetch() is told to cache', () => {
      clears('', POST('url', 'body: input, next: { revalidate: 60 }'))
      clears('', POST('url', `body: input, next: { tags: ['items'] }`))
      clears('', POST('url', `body: input, cache: 'force-cache'`))
      counts('', POST('url', `body: input, cache: 'no-store'`), REQUEST)
      counts('', POST('url', 'body: input, next: input.tags ? { tags: input.tags } : undefined'), REQUEST)
    })

    it('does not count one whose URL says it reads', () => {
      for (const url of ['/search', '/items/lookup', '/rooms/availability', '/getItems', '/get_landing_page/', '/shipping/calculate', '/listOrders']) {
        clears('', POST(`\`\${API_URL}${url}\``))
      }
      for (const url of ['/research', '/getaways', '/items', '/createOrder']) {
        counts('', POST(`\`\${API_URL}${url}\``), REQUEST)
      }
      // What a helper that builds the URL is called says nothing about what the URL is for
      counts('', POST('getApiUrl()'), REQUEST)
      counts('', POST("new URL('/orders', getBaseUrl())"), REQUEST)
      clears('', POST("new URL('/getItems', getBaseUrl())"))
    })

    it('does not count analytics', () => {
      clears('', POST('`${POSTHOG_HOST}/capture/`'))
      clears('', POST("'https://plausible.io/api/event'"))
      clears('', POST("'https://www.google-analytics.com/mp/collect'"))
      // Taking the money is a capture too
      counts('', POST('`https://api-m.paypal.com/v2/checkout/orders/${input.id}/capture`'), REQUEST)
      counts('', POST("'https://api.example.com/track'"), REQUEST)
    })

    it('does not take checking in for a check', () => {
      clears('', POST('`${API_URL}/orders/check`'))
      counts('', POST('`${API_URL}/guests/check-in`'), REQUEST)
      counts('', POST('`${API_URL}/cart/checkout`'), REQUEST)
    })
  })

  describe('with a public form', () => {
    it('does not count one by where it posts, or what it says', () => {
      for (const body of [
        POST("'https://api.example.com/contact'"),
        POST('process.env.CONTACT_FORM_ENDPOINT'),
        POST("'https://api.example.com/newsletter/subscribe'"),
        POST("'https://api.example.com/leads'"),
        POST("'https://connect.mailerlite.com/api/subscribers'"),
        POST('webhook', `body: JSON.stringify({ content: 'New contact form submission' })`),
        POST('webhook', 'body: JSON.stringify({ content: `New waitlist signup: ${input}` })'),
        // A contact form's shape, wherever it goes
        POST(ORDERS, 'body: JSON.stringify({ name: input.name, email: input.email, message: input.message })'),
      ]) {
        clears('', body)
      }
      counts('', POST(ORDERS, 'body: JSON.stringify({ email: input.email, total: input.total })'), REQUEST)
      counts('', POST(ORDERS, 'body: JSON.stringify({ name: input.name, message: input.message })'), REQUEST)
    })

    it('does not take a field for a form', () => {
      counts('', POST("'https://api.razorpay.com/v1/invoices'", 'body: JSON.stringify({ customer: { contact: input.phone } })'), REQUEST)
    })

    it('does not count mail sent over HTTP to one fixed address', () => {
      clears('', POST("'https://api.resend.com/emails'", `body: JSON.stringify({ to: 'me@example.com', subject: input })`))
      counts('', POST("'https://api.resend.com/emails'", 'body: JSON.stringify({ to: input.to, subject: input })'), REQUEST)
    })
  })

  describe('with a model behind a request', () => {
    const MODEL = 'Server action calls an AI model without any authentication check — anyone can call this action and spend your credits'

    it('reports it as a model call', () => {
      for (const [setup, body] of [
        ['', POST("'https://api.openai.com/v1/chat/completions'")],
        ['', POST("'https://api.anthropic.com/v1/messages'")],
        ['', POST('`https://generativelanguage.googleapis.com/v1beta/models/gemini:generateContent?key=${key}`')],
        ['', POST("'https://openrouter.ai/api/v1/chat/completions'")],
        ['', POST("'https://api.groq.com/openai/v1/chat/completions'")],
        ['', POST("'https://my.host/v1/chat/completions'")],
        ['', POST('`https://api.elevenlabs.io/v1/text-to-speech/${voice}`')],
        ['', POST("'https://api.replicate.com/v1/predictions'")],
        ['', POST('`https://api.cloudflare.com/client/v4/accounts/${id}/ai/run/${model}`')],
        ['', POST('process.env.OPENAI_URL')],
        ['', POST('`${endpoint}/api/chat`', 'body: JSON.stringify({ model, messages })')],
        ['', POST('url', 'body: JSON.stringify({ model: name, prompt: input })')],
        [AXIOS, `await axios.post('https://api.openai.com/v1/chat/completions', input)`],
      ]) {
        const findings = check(`${setup}\n${action(body)}`)
        expect(findings, body).toHaveLength(1)
        expect(findings[0].message, body).toBe(MODEL)
      }
    })

    it('takes a limit, as any other model call does', () => {
      expect(check(action(`await rateLimit(input)\n  ${POST("'https://api.openai.com/v1/chat/completions'")}`))).toHaveLength(0)
    })

    // What the file shows it does comes before what a name says it might
    describe('next to a write', () => {
      const SDK = "import { generateText } from 'ai'"
      const HELPER = "import { saveChat } from '@/lib/chats'"

      it('reports what goes out over the model', () => {
        const [finding] = check(`${SDK}\n${action(`await generateText(input)\n  ${POST(ORDERS)}`)}`)
        expect(finding.message).toMatch(REQUEST)
      })

      it('reports the model over a helper named like a write', () => {
        const findings = check(`${SDK}\n${HELPER}\n${action('await generateText(input)\n  await saveChat(input)')}`)
        expect(findings).toHaveLength(1)
        expect(findings[0].message).toBe(MODEL)
        expect(findings[0].fix).toContain('rate-limit')
        expect(findings[0].fix).not.toContain("remove 'use server'")
      })

      it('reports the helper once the model is limited', () => {
        const findings = check(`${SDK}\n${HELPER}\n${action('await rateLimit(input)\n  await generateText(input)\n  await saveChat(input)')}`)
        expect(findings).toHaveLength(1)
        expect(findings[0].message).toContain('calls saveChat()')
      })

      it('does not take a limit in middleware as an answer to the helper', () => {
        const findings = check(`${SDK}\n${HELPER}\n${action('await generateText(input)\n  await saveChat(input)')}`, makeProject({ rateLimitsInMiddleware: true }))
        expect(findings[0].severity).toBe('warning')
      })

      it('lowers a model by a limit in middleware when there\'s nothing else', () => {
        expect(check(`${SDK}\n${action('await generateText(input)')}`, makeProject({ rateLimitsInMiddleware: true }))[0].severity).toBe('info')
      })
    })

    it('does not take a model of a table for one', () => {
      counts('', POST(ORDERS, 'body: JSON.stringify({ model: input.car })'), REQUEST)
    })

    it('reads a model\'s host through any client, and nothing else through one it can\'t see', () => {
      expect(check(`${API}\n${action(`await api.post('https://api.openai.com/v1/chat/completions', input)`)}`)[0].message).toBe(MODEL)
      expect(check(`${API}\n${action(`await api.post('/gemini/chat', input)`)}`)).toHaveLength(0)
      expect(check(`${API}\n${action('await api.post(url, { model, messages })')}`)).toHaveLength(0)
    })
  })

  describe('with a file write', () => {
    it('counts one from the file system, however it got here', () => {
      for (const [setup, body] of [
        [FS, 'await fs.writeFile(input.path, input.data)'],
        [FS, 'await fs.appendFile(input.path, input.data)'],
        [FS, 'await fs.unlink(input.path)'],
        [FS, 'await fs.rm(input.path)'],
        [FS, 'await fs.rmdir(input.path)'],
        [FS, 'await fs.rename(input.from, input.to)'],
        [FS, 'await fs.copyFile(input.from, input.to)'],
        ["import fs from 'fs'", 'fs.writeFileSync(input.path, input.data)'],
        ["import fs from 'fs'", 'fs.unlinkSync(input.path)'],
        ["import fs from 'fs'", 'fs.createWriteStream(input.path)'],
        ["import fs from 'fs'", 'await fs.promises.writeFile(input.path, input.data)'],
        ["import * as fs from 'fs'", 'await fs.promises.unlink(input.path)'],
        ["import { promises as fs } from 'fs'", 'await fs.writeFile(input.path, input.data)'],
        ["import { promises } from 'node:fs'", 'await promises.writeFile(input.path, input.data)'],
        ["import { writeFile } from 'fs/promises'", 'await writeFile(input.path, input.data)'],
        ["import { writeFile as save } from 'node:fs/promises'", 'await save(input.path, input.data)'],
        ["import { unlink } from 'fs/promises'", 'await unlink(input.path)'],
        ["import { createWriteStream } from 'fs'", 'createWriteStream(input.path)'],
        ["import fse from 'fs-extra'", 'await fse.outputFile(input.path, input.data)'],
        ["const fs = require('fs')", 'fs.writeFileSync(input.path, input.data)'],
      ]) {
        counts(setup, body, FILES)
      }
    })

    it('does not take a helper of that name for it', () => {
      onlyKeeps("import { rename } from './files'", 'await rename(input.from, input.to)')
      onlyKeeps('', 'await fs.writeFile(input.path, input.data)')
      onlyKeeps("const fs = require('./my-fs')", 'fs.writeFileSync(input.path, input.data)')
      expect(check(`export async function run(writeFile, input) { return writeFile(input) }`)).toHaveLength(0)
    })

    it('does not count a directory or a read', () => {
      onlyKeeps(FS, 'await fs.mkdir(input.path, { recursive: true })')
      clears(FS, 'return fs.readFile(input.path)')
    })

    it('does not count a temp file', () => {
      for (const [setup, body] of [
        [FS, 'await fs.writeFile(join(tmpdir(), input.name), input.data)'],
        [FS, 'await fs.writeFile(`/tmp/${input.name}`, input.data)'],
        [FS, 'const tempPath = join(dir, input.name)\n  await fs.writeFile(tempPath, input.data)'],
        [FS, 'const tmpFile = join(dir, input.name)\n  await fs.writeFile(tmpFile, input.data)'],
        [FS, 'await fs.unlink(tempPath)'],
        // Written, then deleted
        [FS, 'const p = join(dir, input.name)\n  await fs.writeFile(p, input.data)\n  await parseIt(p)\n  await fs.unlink(p)'],
        [FS, 'const p = join(dir, input.name)\n  try {\n    await fs.writeFile(p, input.data)\n  } finally {\n    await fs.unlink(p)\n  }'],
        ["import { writeFile, unlink } from 'fs/promises'", 'await writeFile(input.path, input.data)\n  await unlink(input.path)'],
      ]) {
        clears(setup, body)
      }
    })

    it('counts what stays', () => {
      for (const body of [
        // Deleted only if it fails: that's a rollback
        'const p = join(dir, input.name)\n  try {\n    await fs.writeFile(p, input.data)\n  } catch (e) {\n    await fs.unlink(p)\n  }',
        'await fs.writeFile(`public/uploads/${input.name}`, input.data)',
        // A temp file put in its place
        'await fs.rename(tempPath, finalPath)',
        'const p = join(dir, input.name)\n  await fs.writeFile(p, input.data)\n  await fs.copyFile(p, input.target)\n  await fs.unlink(p)',
        // Another path
        'await fs.writeFile(input.a, input.data)\n  await fs.unlink(input.b)',
        // Deleted to make way for what's written: that one stays
        'await fs.unlink(input.path)\n  await fs.writeFile(input.path, input.data)',
      ]) {
        counts(FS, body, FILES)
      }
      // Each action on its own: one writes, the other deletes
      expect(check(`${FS}\nexport async function up(input) { await fs.writeFile(path, input) }\nexport async function down(input) { await fs.unlink(path) }`)).toHaveLength(1)
    })

    it('does not count a log or a cache', () => {
      for (const body of [
        'await fs.appendFile(logFile, input)',
        `await fs.appendFile('./logs/app.log', input)`,
        'await fs.appendFile(LOG_PATH, input)',
        'await fs.writeFile(cachePath, input)',
        `await fs.writeFile('./.cache/a.json', input)`,
      ]) {
        clears(FS, body)
      }
      for (const body of [`await fs.writeFile('./blog/post.md', input)`, `await fs.writeFile('./catalog.json', input)`, 'await fs.writeFile(cacheless, input)']) {
        counts(FS, body, FILES)
      }
    })

    it('does not count a public form kept in a file', () => {
      clears(FS, `await fs.appendFile(join(dir, 'enquiries.jsonl'), input)`)
      clears(FS, 'await fs.appendFile(CONTACT_FILE_PATH, input)')
      clears(FS, `await fs.appendFile(join(dir, 'registrations.jsonl'), input)`)
    })
  })

  describe('with mail', () => {
    it('counts mail to an address the caller can set', () => {
      for (const body of [
        'await transporter.sendMail(input)',
        'await transporter.sendMail({ from, to: input.to, subject, html })',
        'await transporter.sendMail({ from, ...input })',
        'await resend.emails.send({ from, to: [input.email], subject: input.subject, html })',
        'await resend.emails.send({ from, to, subject, html })',
        'await resend.batch.send(input)',
        'await sgMail.send({ to: input.to })',
        'await postmark.sendEmail({ To: input.to })',
        'const mailOptions = { to: input.to, html: input.body }\n  await transporter.sendMail(mailOptions)',
        `await transporter.sendMail({ to: input.to || 'me@example.com' })`,
      ]) {
        counts('', body, MAIL)
      }
    })

    it('does not count a contact form: one address that doesn\'t change', () => {
      for (const [setup, body] of [
        ['', 'await transporter.sendMail({ from: input.email, to: process.env.CONTACT_EMAIL, html: input.message })'],
        ['', `await resend.emails.send({ from, to: 'me@example.com', subject: input.subject, html: input.message })`],
        ['', `await resend.emails.send({ from, to: ['me@example.com'], html: input.message })`],
        ['', `const { SMTP_EMAIL } = process.env\n  await transport.sendMail({ to: SMTP_EMAIL, html: input.message })`],
        ['', 'const ADMIN = process.env.ADMIN\n  await transport.sendMail({ to: ADMIN, html: input.message })'],
        ['', 'await transport.sendMail({ to: ADMIN_EMAIL, html: input.message })'],
        ['', `const mailOptions = { to: 'me@example.com', html: input.message }\n  await transporter.sendMail(mailOptions)`],
        ['', 'await transporter.sendMail({ from, subject, html: input.message })'], // The transport's default
        ['', 'await resend.emails.send({ from, to: parseList(process.env.TO), html: input.message })'],
        ['', 'await resend.emails.send({ from, to: process.env.TO.split(","), html: input.message })'],
        ["import { env } from '@/env'", 'await resend.emails.send({ from, to: env.EMAIL_TO, html: input.message })'],
        ["import { config } from '@/config'", 'await resend.emails.send({ from, to: config.email, html: input.message })'],
        ["import { siteConfig } from '@/config/site'", 'await resend.emails.send({ from, to: siteConfig.email, html: input.message })'],
      ]) {
        clears(setup, body)
      }
      // A parameter of that name is whatever the caller says
      expect(check(`export async function run(input, config) { await resend.emails.send({ to: config.email, html: input }) }`)).toHaveLength(1)
    })

    it('reads every object a name stands for', () => {
      expect(check(`export async function a(i) { const mailOptions = { to: 'a@example.com', html: i }; return t.sendMail(mailOptions) }\nexport async function b(i) { const mailOptions = { to: 'b@example.com', html: i }; return t.sendMail(mailOptions) }`)).toHaveLength(0)
      expect(check(`export async function a(i) { const mailOptions = { to: 'a@example.com', html: i }; return t.sendMail(mailOptions) }\nexport async function b(i) { const mailOptions = { to: i.to, html: i }; return t.sendMail(mailOptions) }`)).toHaveLength(1)
      // One of them a parameter: that could be anything
      expect(check(`export async function a(i) { const mailOptions = { to: 'a@example.com', html: i }; return t.sendMail(mailOptions) }\nexport async function b(mailOptions) { return t.sendMail(mailOptions) }`)).toHaveLength(1)
    })

    it('does not count an account\'s own mail: it\'s how signing in works', () => {
      for (const body of [
        `await resend.emails.send({ to: input.email, subject: 'Verify your email', html })`,
        `await resend.emails.send({ to: input.email, subject: 'Reset your password', html })`,
        `await transporter.sendMail({ to: input.email, subject: 'Your one-time password', html })`,
        `await transporter.sendMail({ to: input.email, subject: 'Confirm your email', html })`,
        `await transporter.sendMail({ to: input.email, subject: 'Welcome', html })`,
        `await transporter.sendMail({ to: input.email, subject: 'Account already exists', html })`,
      ]) {
        clears('', body)
      }
      for (const body of ['await resend.emails.send({ to: input.email, subject, react: ResetPasswordEmail({ link }) })', 'await transporter.sendMail({ to: input.email, subject, html: emailVerificationTemplate(url) })']) {
        expect(check(action(body)), body).toHaveLength(0)
      }
      counts('', `await transporter.sendMail({ to: input.email, subject: 'Your invoice', html })`, MAIL)
      // Only what it says: a caller's text could read anything
      counts('', `await transporter.sendMail({ to: input.email, subject: input.subject, html: input.password })`, MAIL)
    })

    it('reads a mail helper the same way', () => {
      const HELPER = "import { sendEmail } from '@/lib/mail'"
      counts(HELPER, 'await sendEmail(input)', MAIL)
      counts(HELPER, 'await sendEmail(input.to, input.subject)', MAIL)
      counts(HELPER, 'await sendEmail({ to: input.to, subject: input.subject })', MAIL)
      counts("import { sendMail as notify } from './mail'", 'await notify(input)', MAIL)
      clears(HELPER, `await sendEmail('me@example.com', input.subject)`)
      clears(HELPER, 'await sendEmail(process.env.ADMIN, input.subject)')
      clears(HELPER, 'await sendEmail({ to: process.env.ADMIN, subject: input.subject })')
      clears("import { sendVerificationEmail } from '@/lib/mail'", 'await sendVerificationEmail(input.email, input.token)')
      clears("import { sendPasswordResetEmail } from '@/lib/mail'", 'await sendPasswordResetEmail(input.email, input.token)')
    })
  })

  describe('with an AWS command', () => {
    const S3 = "import { S3Client, PutObjectCommand, DeleteObjectCommand, CopyObjectCommand, GetObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3'"

    it('counts one that writes', () => {
      counts(S3, 'await s3.send(new PutObjectCommand(input))', CLOUD)
      counts(S3, 'await s3.send(new DeleteObjectCommand(input))', CLOUD)
      counts(S3, 'await s3.send(new CopyObjectCommand(input))', CLOUD)
      // A signed URL is an upload anyone who has it can make
      counts(S3, 'return getSignedUrl(s3, new PutObjectCommand(input))', CLOUD)
      counts("import { PutCommand } from '@aws-sdk/lib-dynamodb'", 'await db.send(new PutCommand(input))', CLOUD)
      counts("import { PublishCommand } from '@aws-sdk/client-sns'", 'await sns.send(new PublishCommand(input))', CLOUD)
      counts("import * as S3 from '@aws-sdk/client-s3'", 'await s3.send(new S3.PutObjectCommand(input))', CLOUD)
    })

    it('does not count one that reads, or a class of that name from elsewhere', () => {
      clears(S3, 'return s3.send(new GetObjectCommand(input))')
      clears(S3, 'return s3.send(new ListObjectsV2Command(input))')
      onlyKeeps("import { PutObjectCommand } from './commands'", 'await s3.send(new PutObjectCommand(input))')
    })

    it('reads mail by its address', () => {
      const SES = "import { SendEmailCommand } from '@aws-sdk/client-ses'"
      counts(SES, 'await ses.send(new SendEmailCommand({ Destination: { ToAddresses: [input.to] }, Message: input }))', MAIL)
      counts(SES, 'await ses.send(new SendEmailCommand(input))', MAIL)
      clears(SES, 'await ses.send(new SendEmailCommand({ Destination: { ToAddresses: [process.env.ADMIN] }, Message: input }))')
    })
  })

  describe('with a key-value store or a bucket', () => {
    it('counts a write', () => {
      for (const [setup, body] of [
        ['', 'await env.KV.put(input.key, input.value)'],
        ['', 'await env.MY_KV.put(input.key, input.value)'],
        ['', 'await env.UPLOADS.put(input.key, input.value)'],
        ['', 'await kv.put(input.key, input.value)'],
        ['', 'await myKv.put(input.key, input.value)'],
        ['', 'await bucket.put(input.key, input.value)'],
        ['', 'await env.R2.put(input.key, input.value)'],
        ["import { put } from '@vercel/blob'", `await put(input.name, input.file, { access: 'public' })`],
        ["import { del } from '@vercel/blob'", 'await del(input.url)'],
        // A cart keeps its TTL, and reads what it's about to change: neither is a cache
        ['', 'const cart = await kv.get(input.id)\n  await kv.put(input.id, input.cart, { expirationTtl: 60 })'],
      ]) {
        counts(setup, body, CLOUD)
      }
    })

    it('does not count a read-through cache', () => {
      for (const body of [
        'await env.KV.put(cacheKey, value)',
        'await env.KV.put(`cache:${input}`, value)',
        'await kv.put(PROJECT_CACHE_KEY, value, { expirationTtl: 60 })',
        'const cached = await env.KV.get(cacheKey)\n  if (cached) return cached\n  const fresh = await loadIt(input)\n  await env.KV.put(cacheKey, fresh)',
      ]) {
        clears('', body)
      }
    })

    it('does not count what signing in keeps there, or a public form', () => {
      expect(check(action('await env.KV.put(getResetTokenKey(input), value)'))).toHaveLength(0)
      clears('', 'await env.KV.put(`password-reset:${input}`, value)')
      clears('', 'await waitlist_kv.put(input, value)')
      clears('', 'await env.KV.put(`waitlist:${input}`, value)')
    })

    it('does not take anything with a put() for one', () => {
      onlyKeeps("import { put } from './store'", 'await put(input.name, input.file)')
      onlyKeeps(API, 'await api.put(url, input)')
      counts(AXIOS, 'await axios.put(url, input)', REQUEST)
      // The Cache API's
      expect(check(action('const cache = await caches.open(input)\n  await cache.put(input, value)'))).toHaveLength(0)
      clears('', 'const cache = await getCache(input)\n  await cache.put(input, value)')
      // A bucket with the word in its name still holds what it's given
      counts('', 'await env.NEXT_INC_CACHE_R2_BUCKET.put(`responses/${input}.json`, value)', CLOUD)
    })
  })

  describe('with a helper named like a write', () => {
    it('counts one from the project', () => {
      for (const [setup, call, name] of [
        ["import { deletePhoto } from '@/lib/photos'", 'await deletePhoto(input.id)', 'deletePhoto'],
        ["import { createTodo } from './todos'", 'await createTodo(input)', 'createTodo'],
        ["import { saveMeal } from '../lib/meals'", 'await saveMeal(input)', 'saveMeal'],
        ["import { updateUser } from '~/server/users'", 'await updateUser(input)', 'updateUser'],
        ["import { removeFromCart } from 'lib/cart'", 'await removeFromCart(input)', 'removeFromCart'],
        ["import { addBookmark } from '#/data'", 'await addBookmark(input)', 'addBookmark'],
        ["import { uploadImage } from '@/lib/images'", 'await uploadImage(input)', 'uploadImage'],
        ["import { publishPost } from '@/lib/posts'", 'await publishPost(input)', 'publishPost'],
        ["import { sendInvoice } from '@/lib/billing'", 'await sendInvoice(input)', 'sendInvoice'],
        ["import { markPaid } from '@/lib/billing'", 'await markPaid(input)', 'markPaid'],
        ["import { writeJsonFile } from './base'", 'await writeJsonFile(input)', 'writeJsonFile'],
        // By the name it was exported under
        ["import { deletePhoto as drop } from '@/lib/photos'", 'await drop(input.id)', 'deletePhoto'],
      ]) {
        const message = new RegExp(`^Server action calls ${name}\\(\\), which reads as a write, without any authentication check`)
        counts(setup, call, message)
      }
    })

    it('does not count what it can\'t tell is one', () => {
      for (const [setup, body] of [
        // From a package
        ["import { createTodo } from 'todo-sdk'", 'await createTodo(input)'],
        // Not much of a name
        ["import { update } from './db'", 'await update(input)'],
        ["import { remove } from './db'", 'await remove(input)'],
        // A service could forward a token
        ["import * as photos from './photos'", 'await photos.deletePhoto(input)'],
        ["import { photos } from './photos'", 'await photos.deletePhoto(input)'],
        // Not imported, or a verb that isn't on the list
        ['', 'await deletePhoto(input)'],
        ["import { guardarUsuario } from './db'", 'await guardarUsuario(input)'],
      ]) {
        onlyKeeps(setup, body)
      }
    })

    it('reads a helper in the file by its body', () => {
      expect(check(`function deletePhoto(id) { return id }\n${action('return deletePhoto(input)')}`)).toHaveLength(0)
      expect(check(`async function deletePhoto(id) { ${POST(ORDERS)} }\n${action('return deletePhoto(input)')}`)).toHaveLength(1)
    })

    it('does not take a parameter or a read for one', () => {
      expect(check(`export async function run(deletePhoto, input) { return deletePhoto(input) }`)).toHaveLength(0)
      expect(check(`import { deletePhoto } from './photos'\nexport async function run(deletePhoto, input) { return deletePhoto(input) }`)).toHaveLength(0)
      expect(check(`import { getUser as deletePhoto } from './users'\n${action('return deletePhoto(input)')}`)).toHaveLength(0)
    })

    it('does not count a helper that makes a value', () => {
      for (const name of ['createErrorResponse', 'createSupabaseServer', 'createClient', 'createApiKey', 'createShortUrl', 'createServerAction', 'createSessionToken', 'createFormData', 'createSlug', 'createStore', 'createTemplate', 'createBlogGenerator', 'addDays', 'addMinutes', 'addLeadingZeros', 'removeAccents', 'removeDiacritics', 'removeHtmlTags', 'updateSession', 'resetForm']) {
        expect(check(`import { ${name} } from '@/lib/utils'\n${action(`return ${name}(input)`)}`), name).toHaveLength(0)
      }
    })

    // Not counting one isn't saying it's harmless: resetPassword() is a write
    it('keeps the finding of what it doesn\'t count', () => {
      for (const [setup, body] of [
        ["import { createApiKey } from '@/lib/keys'", 'await createApiKey(input)'],
        ["import { resetPassword } from './accounts'", 'await resetPassword(input)'],
        ["import { createInquiry } from './crm'", 'await createInquiry(input)'],
        ["import { saveDraft } from './actions'", 'await saveDraft(input)'],
        ["import { createPost } from './api'", 'await createPost(input, token)'],
      ]) {
        onlyKeeps(setup, body)
      }
    })

    it('leaves another action to its own reading', () => {
      for (const setup of ["import { updateProjectAction as saveDraft } from './projects'", "import { saveDraft } from '@/actions/drafts'", "import { saveDraft } from './actions'", "import { saveDraft } from '@/app/_actions'", "import { saveDraft } from './drafts.action'"]) {
        expect(check(`${setup}\n${action('await saveDraft(input)')}`), setup).toHaveLength(0)
      }
      counts("import { saveDraft } from './transactions'", 'await saveDraft(input)', /saveDraft/)
    })

    it('does not count what signing in or a public form does', () => {
      for (const setup of ["import { resetPassword as run2 } from './accounts'", "import { createVerification as run2 } from './accounts'", "import { createInquiry as run2 } from './crm'", "import { createLead as run2 } from './crm'"]) {
        expect(check(`${setup}\n${action('await run2(input)')}`), setup).toHaveLength(0)
      }
    })

    it('does not count one handed the caller\'s token', () => {
      for (const arg of ['token', 'accessToken', 'session', 'input.jwt']) {
        expect(check(`import { createPost } from './api'\n${action(`await createPost(input, ${arg})`)}`), arg).toHaveLength(0)
      }
      counts("import { createPost } from './api'", 'await createPost(input, title)', /createPost/)
    })
  })

  describe('reads each action', () => {
    const WRITE = POST(ORDERS)

    it('does not count one that checks the user in a way the patterns don\'t know', () => {
      for (const body of ['await requireAdmin()', 'await requireUser()', 'await assertOwner(input)', 'await ensureAdmin()', 'await checkPermission(input)', 'await requireRole(input)', 'const user = await getCurrentUser()', 'const user = await getUser()', 'const me = await getLoggedInUser()', 'const id = await getUserId()', 'const user = await fetchUser()', 'const user = await db.requireUser()']) {
        expect(check(action(`${body}\n  ${WRITE}`)), body).toHaveLength(0)
      }
    })

    // The verdict doesn't flip on an unrelated push() either
    it('does not keep a finding for an action it leaves alone', () => {
      expect(check(action(`await requireAdmin()\n  ${NEXT_TO_A_PUSH}${WRITE}`))).toHaveLength(0)
      expect(check(`export async function login(input) {\n  ${NEXT_TO_A_PUSH}${WRITE}\n}`)).toHaveLength(0)
      expect(check(`const login = async (input) => {\n  ${NEXT_TO_A_PUSH}${WRITE}\n}\nexport { login }`)).toHaveLength(0)
      // Through a helper only it reaches, and only that
      expect(check(`async function send(input) { ${WRITE} }\nexport async function login(input) {\n  ${NEXT_TO_A_PUSH}return send(input)\n}`)).toHaveLength(0)
      expect(check(`async function send(input) { ${WRITE} }\nexport async function login(input) {\n  ${NEXT_TO_A_PUSH}return send(input)\n}\nexport async function pay(input) { return send(input) }`)).toHaveLength(1)
      // A write comes first, whatever the action's called
      expect(check(`export async function login(input) { await prisma.item.create({ data: input }) }`)).toHaveLength(1)
      // What only keeps a finding still does, next to what it doesn't leave alone
      expect(check(`export async function login(input) { ${WRITE} }\nexport async function run(input) {\n  ${NEXT_TO_A_PUSH}await clearCart(input)\n}`)).toHaveLength(1)
    })

    it('does not take a look-up of someone else for one', () => {
      expect(check(action(`const user = await getUser(input.id)\n  ${WRITE}`))).toHaveLength(1)
      expect(check(action(`const user = await getCurrentUser(input.id)\n  ${WRITE}`))).toHaveLength(1)
      expect(check(action(`const admin = isAdminRoute()\n  ${WRITE}`))).toHaveLength(1)
      expect(check(action(`const user = await getUserById()\n  ${WRITE}`))).toHaveLength(1)
      expect(check(action(`validateUserInput(input)\n  ${WRITE}`))).toHaveLength(1)
      expect(check(action(`verifyUserEmail(input)\n  ${WRITE}`))).toHaveLength(1)
    })

    it('reads a verification of the caller as a check', () => {
      expect(check(action(`await verifyUser(input)\n  ${WRITE}`))).toHaveLength(0)
      expect(check(action(`await validateAdmin(input)\n  ${WRITE}`))).toHaveLength(0)
      expect(check(action(`if (!(await isAdmin())) return\n  ${WRITE}`))).toHaveLength(0)
      expect(check(action(`if (!(await hasPermission(input))) return\n  ${WRITE}`))).toHaveLength(0)
    })

    it('finds the check through the file\'s own helpers', () => {
      expect(check(`async function guard() { return requireAdmin() }\n${action(`await guard()\n  ${WRITE}`)}`)).toHaveLength(0)
    })

    it('does not let one action\'s check cover another', () => {
      expect(check(`export async function a(input) { await requireAdmin()\n ${WRITE} }\nexport async function b(input) { ${WRITE} }`)).toHaveLength(1)
      expect(check(`export async function a(input) { await requireAdmin()\n ${WRITE} }`)).toHaveLength(0)
    })

    it('leaves a checked action or a guest action out of it', () => {
      expect(check(`export const run = authActionClient.action(async ({ parsedInput }) => { ${WRITE} })`)).toHaveLength(0)
      expect(check(`export const run = actionClient.use(throwIfAuthenticated).action(async ({ parsedInput }) => { ${WRITE} })`)).toHaveLength(0)
      expect(check(`export const a = authActionClient.action(async ({ parsedInput }) => { ${WRITE} })\nexport async function b(input) { return input }`)).toHaveLength(0)
    })

    it('follows an action into the file\'s helpers, and nowhere else', () => {
      expect(check(`async function send(input) { ${WRITE} }\n${action('return send(input)')}`)).toHaveLength(1)
      expect(check(`const send = async (input) => { ${WRITE} }\n${action('return send(input)')}`)).toHaveLength(1)
      expect(check(`async function unused(input) { ${WRITE} }\n${action('return input')}`)).toHaveLength(0)
      expect(check(`${WRITE}\n${action('return input')}`)).toHaveLength(0)
    })

    it('reads only the action in a page with an inline one', () => {
      const page = (body: string) => serverActionAuthRule.check(makeFile(body, { relativePath: 'app/page.tsx' }), project)
      expect(page(`export default async function Page() {\n  await fetch(url, { method: 'POST' })\n  async function act(fd) {\n    'use server'\n    return fd\n  }\n  return <form action={act} />\n}\n`)).toHaveLength(0)
      expect(page(`export default async function Page() {\n  async function act(fd) {\n    'use server'\n    await fetch(url, { method: 'POST', body: fd })\n  }\n  return <form action={act} />\n}\n`)).toHaveLength(1)
      // One it leaves alone, as it would an export
      expect(page(`export default async function Page() {\n  async function act(fd) {\n    'use server'\n    await requireAdmin()\n    await fetch(url, { method: 'POST', body: fd })\n  }\n  return <form action={act} />\n}\n`)).toHaveLength(0)
      expect(page(`export default async function Page() {\n  async function login(fd) {\n    'use server'\n    await fetch(url, { method: 'POST', body: fd })\n  }\n  return <form action={login} />\n}\n`)).toHaveLength(0)
    })

    it('leaves a route handler to auth-checks', () => {
      expect(check(`export async function POST(input) { ${WRITE} }`, project, 'app/api/items/route.ts')).toHaveLength(0)
      expect(check(`export async function run(input) { ${WRITE} }`, project, 'pages/api/items.ts')).toHaveLength(0)
    })

    it('leaves a public-named path out of it, as it does a write', () => {
      for (const body of [WRITE, 'await transporter.sendMail(input)', 'await env.KV.put(input.key, input.value)']) {
        expect(check(action(body), project, 'app/actions/contact.ts'), body).toHaveLength(0)
        expect(check(action(body), project, 'app/login/actions.ts'), body).toHaveLength(0)
      }
    })
  })

  describe('in what it reports', () => {
    it('says what it read, unless a write comes first', () => {
      expect(check(action(`await prisma.item.create({ data: input })\n  ${POST(ORDERS)}`))[0].message).toContain('performs mutations')
      expect(check(action(`await transporter.sendMail(input)\n  ${POST(ORDERS)}`))[0].message).toMatch(/^Server action (?:sends email|sends a write request)/)
    })

    it('says what the file shows before what only a name says', () => {
      const HELPER = "import { saveChat } from '@/lib/chats'"
      expect(check(`${HELPER}\n${action(`await saveChat(input)\n  ${POST(ORDERS)}`)}`)[0].message).toMatch(REQUEST)
      expect(check(`${HELPER}\n${action(`${POST(ORDERS)}\n  await saveChat(input)`)}`)[0].message).toMatch(REQUEST)
      expect(check(`${HELPER}\nasync function send(input) { ${POST(ORDERS)} }\n${action('await saveChat(input)\n  await send(input)')}`)[0].message).toMatch(REQUEST)
    })

    it('asks whether it should be an action at all', () => {
      const [finding] = check(action(POST(ORDERS)))
      expect(finding.fix).toContain('const session = await auth()')
      expect(finding.fix).toContain("If only server code calls it, remove 'use server' instead")
      expect(check(action('await prisma.item.create({ data: input })'))[0].fix).not.toContain("remove 'use server'")
    })

    it('rates it by the auth middleware like a write', () => {
      const middleware = check(action(POST(ORDERS)), makeProject({ hasAuthMiddleware: true }))
      expect(middleware).toHaveLength(1)
      expect(middleware[0].severity).toBe('info')
      expect(middleware[0].message).toBe('Server action sends a write request without an inline auth check (middleware auth detected — verify coverage)')
      expect(middleware[0].fix).toContain('in the action')
      expect(middleware[0].fix).toContain("remove 'use server'")

      const apiOnly = check(action(POST(ORDERS)), makeProject({ hasAuthMiddleware: true, authMiddlewareExcludesPages: true }))
      expect(apiOnly[0].severity).toBe('warning')
      expect(apiOnly[0].message).toBe("Server action sends a write request without any authentication check (middleware auth detected, but its matcher doesn't cover pages)")
    })

    it('stays a warning under rate-limiting middleware', () => {
      const findings = check(action(POST(ORDERS)), makeProject({ rateLimitsInMiddleware: true }))
      expect(findings[0].severity).toBe('warning')
      expect(findings[0].message).toContain('anyone can call this action')
    })

    it('leaves a file Babel can\'t parse to the text check', () => {
      const file = makeFile(`'use server'\n${action(POST(ORDERS))}\n`, { relativePath: 'app/actions/items.ts', withAst: false })
      expect(serverActionAuthRule.check(file, project)).toHaveLength(0)
    })

    it('leaves an action with an auth check alone', () => {
      expect(check(action(`const session = await auth()\n  ${POST(ORDERS)}`))).toHaveLength(0)
    })

    it('works through the scanner', async () => {
      const result = await scanFiles({
        'lib/mail.ts': `"use server";
import nodemailer from "nodemailer";

const transporter = nodemailer.createTransport({ url: process.env.SMTP_URL });

export async function sendMail({ to, subject, html }: { to: string; subject: string; html: string }) {
  await transporter.sendMail({ from: process.env.MAIL_FROM, to, subject, html });
}
`,
        'app/actions.ts': `"use server";
const API = process.env.API_URL;

export async function pay(amount: number) {
  await fetch(\`\${API}/charges\`, { method: "POST", headers: { Authorization: \`Bearer \${process.env.API_KEY}\` }, body: JSON.stringify({ amount }) });
}
`,
        'app/data.ts': `"use server";
export async function listItems() {
  const res = await fetch(process.env.API_URL + "/graphql", { method: "POST", body: JSON.stringify({ query: "{ items { id } }" }) });
  return res.json();
}
`,
      })
      const findings = result.findings.filter(f => f.ruleId === 'server-action-auth')
      expect(findings.map(f => f.file).sort()).toEqual(['app/actions.ts', 'lib/mail.ts'])
    })
  })

  describe('with a very long file', () => {
    it('does not stall on many requests', () => {
      const lines = Array.from({ length: 5000 }, (_, i) => `  await fetch(url${i}, { method: 'POST', headers, body: input })`).join('\n')
      expect(check(`export async function run(input, headers) {\n${lines}\n}`)).toHaveLength(0)
    })

    it('does not stall on many file writes', () => {
      const lines = Array.from({ length: 5000 }, (_, i) => `  await fs.writeFile(tempPath${i}, input)`).join('\n')
      expect(check(`${FS}\nexport async function run(input) {\n${lines}\n}`)).toHaveLength(0)
    })

    it('survives a long chain of aliases', () => {
      const aliases = Array.from({ length: 3000 }, (_, i) => `const u${i} = u${i + 1}`).join('\n')
      expect(() => check(`${aliases}\nconst u3000 = 'https://api.example.com/orders'\n${action(POST('u0'))}`)).not.toThrow()
    })

    it('survives a deep string', () => {
      const deep = Array.from({ length: 2000 }, () => "'a'").join(' + ')
      expect(() => check(action(POST(deep)))).not.toThrow()
    })
  })
})
