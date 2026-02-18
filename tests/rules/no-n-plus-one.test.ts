import { describe, it, expect } from 'vitest'
import { noNPlusOneRule } from '../../src/rules/no-n-plus-one.js'
import { makeFile, makeProject } from '../helpers.js'

const project = makeProject()

describe('no-n-plus-one rule', () => {
  it('detects fetch inside for loop', () => {
    const file = makeFile([
      'for (const id of ids) {',
      '  const res = await fetch(`/api/${id}`)',
      '}',
    ].join('\n'))
    const findings = noNPlusOneRule.check(file, project)
    expect(findings).toHaveLength(1)
    expect(findings[0].message).toContain('N+1')
  })

  it('detects prisma call inside forEach', () => {
    const file = makeFile([
      'items.forEach(async (item) => {',
      '  await prisma.user.findUnique({ where: { id: item.id } })',
      '})',
    ].join('\n'))
    const findings = noNPlusOneRule.check(file, project)
    expect(findings).toHaveLength(1)
  })

  it('reports only once per loop', () => {
    const file = makeFile([
      'for (const id of ids) {',
      '  const user = await prisma.user.findUnique({ where: { id } })',
      '  const posts = await prisma.post.findMany({ where: { userId: id } })',
      '}',
    ].join('\n'))
    const findings = noNPlusOneRule.check(file, project)
    expect(findings).toHaveLength(1)
  })

  it('ignores fetch outside loops', () => {
    const file = makeFile(`const res = await fetch('/api/users')`)
    const findings = noNPlusOneRule.check(file, project)
    expect(findings).toHaveLength(0)
  })

  it('skips test files', () => {
    const file = makeFile([
      'for (const id of ids) {',
      '  await fetch(`/api/${id}`)',
      '}',
    ].join('\n'), { relativePath: 'tests/api.test.ts' })
    const findings = noNPlusOneRule.check(file, project)
    expect(findings).toHaveLength(0)
  })

  it('skips script files', () => {
    const file = makeFile([
      'for (const id of ids) {',
      '  await fetch(`/api/${id}`)',
      '}',
    ].join('\n'), { relativePath: 'scripts/seed.ts' })
    const findings = noNPlusOneRule.check(file, project)
    expect(findings).toHaveLength(0)
  })
})
