import { describe, it, expect } from 'vitest'
import { serverActionAuthRule } from '../../src/rules/server-action-auth.js'
import { makeFile, makeProject } from '../helpers.js'

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

  it('skips public action patterns', () => {
    const file = makeFile(`'use server'
export async function submitFeedback(data) {
  await db.insert(feedback).values(data)
}`, { relativePath: 'actions/feedback.ts' })
    const findings = serverActionAuthRule.check(file, project)
    expect(findings).toHaveLength(0)
  })
})
