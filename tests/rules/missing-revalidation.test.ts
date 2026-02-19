import { describe, it, expect } from 'vitest'
import { missingRevalidationRule } from '../../src/rules/missing-revalidation.js'
import { makeFile, makeProject } from '../helpers.js'

const project = makeProject()

describe('missing-revalidation rule', () => {
  it('detects server action with insert but no revalidation', () => {
    const file = makeFile(`'use server'
export async function addItem(data) {
  await db.insert(data)
}`)
    const findings = missingRevalidationRule.check(file, project)
    expect(findings).toHaveLength(1)
    expect(findings[0].ruleId).toBe('missing-revalidation')
  })

  it('allows server action with revalidatePath', () => {
    const file = makeFile(`'use server'
import { revalidatePath } from 'next/cache'
export async function addItem(data) {
  await db.insert(data)
  revalidatePath('/items')
}`)
    const findings = missingRevalidationRule.check(file, project)
    expect(findings).toHaveLength(0)
  })

  it('allows server action with revalidateTag', () => {
    const file = makeFile(`'use server'
import { revalidateTag } from 'next/cache'
export async function addItem(data) {
  await db.insert(data)
  revalidateTag('items')
}`)
    const findings = missingRevalidationRule.check(file, project)
    expect(findings).toHaveLength(0)
  })

  it('allows server action with redirect (implicit revalidation)', () => {
    const file = makeFile(`'use server'
export async function addItem(data) {
  await db.insert(data)
  redirect('/items')
}`)
    const findings = missingRevalidationRule.check(file, project)
    expect(findings).toHaveLength(0)
  })

  it('ignores non-server-action files', () => {
    const file = makeFile(`
export async function addItem(data) {
  await db.insert(data)
}`)
    const findings = missingRevalidationRule.check(file, project)
    expect(findings).toHaveLength(0)
  })

  it('ignores server actions without mutations', () => {
    const file = makeFile(`'use server'
export async function getItems() {
  return await db.query()
}`)
    const findings = missingRevalidationRule.check(file, project)
    expect(findings).toHaveLength(0)
  })

  it('detects update without revalidation', () => {
    const file = makeFile(`'use server'
export async function updateItem(id, data) {
  await db.update(data).where({ id })
}`)
    const findings = missingRevalidationRule.check(file, project)
    expect(findings).toHaveLength(1)
  })
})
