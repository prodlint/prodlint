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

  it('does not count a .use() that shows no check', () => {
    for (const client of [
      // dub's send-otp and create-user-account: it turns signed-in users away
      'actionClient.use(throwIfAuthenticated)',
      'actionClient.use(throwIfUserAuthenticated)',
      'actionClient.use(redirectIfSession)',
      // ...and this lets anyone in
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
    // An unless-style guard does check
    expect(check(built('actionClient.use(throwIfNotAuthenticated)', ''))).toHaveLength(0)
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

  // dub's real shapes: the client file has no 'use server', and an OTP action's .use() is the opposite of a check
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
    })
    expect(result.findings.filter(f => f.ruleId === 'server-action-auth').map(f => f.file)).toEqual(['lib/actions/send-otp.ts'])
  })
})
