import { describe, it, expect } from 'vitest'
import { nextServerActionValidationRule } from '../../src/rules/next-server-action-validation.js'
import { makeFile, makeProject } from '../helpers.js'

const project = makeProject()

describe('next-server-action-validation rule', () => {
  it('flags server action with unvalidated formData', () => {
    const file = makeFile([
      "'use server'",
      '',
      'export async function submit(formData: FormData) {',
      '  const name = formData.get("name")',
      '  await db.insert({ name })',
      '}',
    ].join('\n'), { relativePath: 'src/actions/submit.ts' })
    const findings = nextServerActionValidationRule.check(file, project)
    expect(findings).toHaveLength(1)
    expect(findings[0].severity).toBe('critical')
  })

  it('allows server action with Zod parse', () => {
    const file = makeFile([
      "'use server'",
      '',
      'export async function submit(formData: FormData) {',
      '  const data = schema.parse(Object.fromEntries(formData))',
      '  await db.insert(data)',
      '}',
    ].join('\n'), { relativePath: 'src/actions/submit.ts' })
    const findings = nextServerActionValidationRule.check(file, project)
    expect(findings).toHaveLength(0)
  })

  it('allows server action with safeParse', () => {
    const file = makeFile([
      "'use server'",
      '',
      'export async function submit(formData: FormData) {',
      '  const result = schema.safeParse(Object.fromEntries(formData))',
      '  const name = formData.get("name")',
      '}',
    ].join('\n'), { relativePath: 'src/actions/submit.ts' })
    const findings = nextServerActionValidationRule.check(file, project)
    expect(findings).toHaveLength(0)
  })

  it('allows server action with validate()', () => {
    const file = makeFile([
      "'use server'",
      '',
      'export async function submit(formData: FormData) {',
      '  const data = validate(formData.get("name"))',
      '}',
    ].join('\n'), { relativePath: 'src/actions/submit.ts' })
    const findings = nextServerActionValidationRule.check(file, project)
    expect(findings).toHaveLength(0)
  })

  it('ignores files without use server', () => {
    const file = makeFile([
      'export async function submit(formData: FormData) {',
      '  const name = formData.get("name")',
      '}',
    ].join('\n'), { relativePath: 'src/lib/form.ts' })
    const findings = nextServerActionValidationRule.check(file, project)
    expect(findings).toHaveLength(0)
  })

  it('ignores server actions without formData.get', () => {
    const file = makeFile([
      "'use server'",
      '',
      'export async function fetchData() {',
      '  return await db.query()',
      '}',
    ].join('\n'), { relativePath: 'src/actions/data.ts' })
    const findings = nextServerActionValidationRule.check(file, project)
    expect(findings).toHaveLength(0)
  })

  it('includes fix suggestion', () => {
    const file = makeFile([
      "'use server'",
      'export async function submit(formData: FormData) {',
      '  const name = formData.get("name")',
      '}',
    ].join('\n'), { relativePath: 'src/actions/submit.ts' })
    const findings = nextServerActionValidationRule.check(file, project)
    expect(findings[0].fix).toContain('Zod')
  })

  it('skips test files', () => {
    const file = makeFile([
      "'use server'",
      'export async function submit(formData: FormData) {',
      '  const name = formData.get("name")',
      '}',
    ].join('\n'), { relativePath: 'tests/actions.test.ts' })
    const findings = nextServerActionValidationRule.check(file, project)
    expect(findings).toHaveLength(0)
  })
})
