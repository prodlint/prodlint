import { describe, it, expect } from 'vitest'
import { noUnboundedQueryRule } from '../../src/rules/no-unbounded-query.js'
import { makeFile, makeProject } from '../helpers.js'

const project = makeProject()

describe('no-unbounded-query rule', () => {
  it('detects .findMany() with no args', () => {
    const file = makeFile(`const users = await prisma.user.findMany()`)
    const findings = noUnboundedQueryRule.check(file, project)
    expect(findings).toHaveLength(1)
    expect(findings[0].message).toContain('findMany')
  })

  it('detects .findMany({}) without take', () => {
    const file = makeFile([
      'const users = await prisma.user.findMany({',
      '  where: { active: true },',
      '})',
    ].join('\n'))
    const findings = noUnboundedQueryRule.check(file, project)
    expect(findings).toHaveLength(1)
  })

  it('ignores .findMany with take', () => {
    const file = makeFile([
      'const users = await prisma.user.findMany({',
      '  where: { active: true },',
      '  take: 100,',
      '})',
    ].join('\n'))
    const findings = noUnboundedQueryRule.check(file, project)
    expect(findings).toHaveLength(0)
  })

  it('detects select(*) without limit or filter', () => {
    const file = makeFile(`const { data } = await supabase.from('users').select('*')`)
    const findings = noUnboundedQueryRule.check(file, project)
    expect(findings).toHaveLength(1)
  })

  it('ignores select(*) with .limit()', () => {
    const file = makeFile(`const { data } = await supabase.from('users').select('*').limit(50)`)
    const findings = noUnboundedQueryRule.check(file, project)
    expect(findings).toHaveLength(0)
  })

  it('ignores select(*) with .eq() filter', () => {
    const file = makeFile(`const { data } = await supabase.from('users').select('*').eq('id', userId)`)
    const findings = noUnboundedQueryRule.check(file, project)
    expect(findings).toHaveLength(0)
  })

  it('ignores select(*) with .single()', () => {
    const file = makeFile(`const { data } = await supabase.from('users').select('*').single()`)
    const findings = noUnboundedQueryRule.check(file, project)
    expect(findings).toHaveLength(0)
  })

  it('ignores select(*) with .maybeSingle()', () => {
    const file = makeFile(`const { data } = await supabase.from('profiles').select('*').maybeSingle()`)
    const findings = noUnboundedQueryRule.check(file, project)
    expect(findings).toHaveLength(0)
  })

  it('ignores select(*) with .match()', () => {
    const file = makeFile(`const { data } = await supabase.from('posts').select('*').match({ user_id: id })`)
    const findings = noUnboundedQueryRule.check(file, project)
    expect(findings).toHaveLength(0)
  })

  it('ignores select(*) with .range()', () => {
    const file = makeFile(`const { data } = await supabase.from('items').select('*').range(0, 9)`)
    const findings = noUnboundedQueryRule.check(file, project)
    expect(findings).toHaveLength(0)
  })

  it('skips test files', () => {
    const file = makeFile(`const users = await prisma.user.findMany()`, { relativePath: 'tests/user.test.ts' })
    const findings = noUnboundedQueryRule.check(file, project)
    expect(findings).toHaveLength(0)
  })

  it('skips script files', () => {
    const file = makeFile(`const { data } = await supabase.from('users').select('*')`, { relativePath: 'scripts/export.ts' })
    const findings = noUnboundedQueryRule.check(file, project)
    expect(findings).toHaveLength(0)
  })

  it('detects select(*) on multiline chain without bounds', () => {
    const file = makeFile([
      "const { data } = await supabase",
      "  .from('users')",
      "  .select('*')",
      "  .order('created_at')",
    ].join('\n'))
    const findings = noUnboundedQueryRule.check(file, project)
    expect(findings).toHaveLength(1)
  })
})
