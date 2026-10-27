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

  it('skips when auth middleware exists', () => {
    const proj = makeProject({ hasAuthMiddleware: true })
    const file = makeFile(`'use server'
export async function deleteItem(id) {
  await db.delete(items).where({ id })
}`)
    const findings = serverActionAuthRule.check(file, proj)
    expect(findings).toHaveLength(0)
  })

  // Through the scanner: Next.js 16 renamed middleware.ts to proxy.ts
  it('skips when a Next.js 16 proxy does the auth', async () => {
    const action = { 'app/actions/items.ts': "'use server'\nexport async function deleteItem(id) {\n  await db.delete(items).where({ id })\n}\n" }
    const findings = async (files: Record<string, string>) =>
      (await scanFiles(files)).findings.filter(f => f.ruleId === 'server-action-auth')

    expect(await findings(action)).toHaveLength(1)
    expect(await findings({ ...action, 'proxy.ts': "export { auth as proxy } from '@/auth'\n" })).toHaveLength(0)
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
