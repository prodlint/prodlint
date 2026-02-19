import { describe, it, expect } from 'vitest'
import { missingTransactionRule } from '../../src/rules/missing-transaction.js'
import { makeFile, makeProject } from '../helpers.js'

const prismaProject = makeProject({
  declaredDependencies: new Set(['@prisma/client']),
})

describe('missing-transaction rule', () => {
  it('flags 2+ Prisma writes without $transaction', () => {
    const file = makeFile([
      'await prisma.user.create({ data: { name } })',
      'await prisma.log.create({ data: { action: "signup" } })',
    ].join('\n'), { relativePath: 'src/auth.ts' })
    const findings = missingTransactionRule.check(file, prismaProject)
    expect(findings).toHaveLength(1)
    expect(findings[0].message).toContain('2 Prisma write')
  })

  it('allows single Prisma write', () => {
    const file = makeFile(
      'await prisma.user.create({ data: { name } })',
      { relativePath: 'src/auth.ts' },
    )
    const findings = missingTransactionRule.check(file, prismaProject)
    expect(findings).toHaveLength(0)
  })

  it('allows writes wrapped in $transaction', () => {
    const file = makeFile([
      'await prisma.$transaction([',
      '  prisma.user.create({ data: { name } }),',
      '  prisma.log.create({ data: { action: "signup" } }),',
      '])',
    ].join('\n'), { relativePath: 'src/auth.ts' })
    const findings = missingTransactionRule.check(file, prismaProject)
    expect(findings).toHaveLength(0)
  })

  it('skips when Prisma is not a dependency', () => {
    const file = makeFile([
      'await prisma.user.create({ data: { name } })',
      'await prisma.log.create({ data: { action: "signup" } })',
    ].join('\n'), { relativePath: 'src/auth.ts' })
    const findings = missingTransactionRule.check(file, makeProject())
    expect(findings).toHaveLength(0)
  })

  it('skips test files', () => {
    const file = makeFile([
      'await prisma.user.create({ data: { name } })',
      'await prisma.log.delete({ where: { id } })',
    ].join('\n'), { relativePath: 'tests/auth.test.ts' })
    const findings = missingTransactionRule.check(file, prismaProject)
    expect(findings).toHaveLength(0)
  })

  it('includes fix suggestion', () => {
    const file = makeFile([
      'await prisma.user.update({ where: { id }, data: { name } })',
      'await prisma.log.create({ data: { action: "update" } })',
    ].join('\n'), { relativePath: 'src/users.ts' })
    const findings = missingTransactionRule.check(file, prismaProject)
    expect(findings[0].fix).toContain('$transaction')
  })

  it('detects mixed write operations', () => {
    const file = makeFile([
      'await prisma.user.update({ where: { id }, data: { active: false } })',
      'await prisma.session.deleteMany({ where: { userId: id } })',
      'await prisma.log.create({ data: { action: "deactivate" } })',
    ].join('\n'), { relativePath: 'src/users.ts' })
    const findings = missingTransactionRule.check(file, prismaProject)
    expect(findings).toHaveLength(1)
    expect(findings[0].message).toContain('3 Prisma write')
  })
})
