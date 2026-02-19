import { describe, it, expect } from 'vitest'
import { hallucinatedApiRule } from '../../src/rules/hallucinated-api.js'
import { makeFile, makeProject } from '../helpers.js'

const project = makeProject()

describe('hallucinated-api rule', () => {
  it('detects .flatten() → .flat()', () => {
    const file = makeFile(`const flat = arr.flatten()`)
    const findings = hallucinatedApiRule.check(file, project)
    expect(findings).toHaveLength(1)
    expect(findings[0].message).toContain('.flat()')
  })

  it('detects .contains() → .includes()', () => {
    const file = makeFile(`if (arr.contains(x)) {}`)
    const findings = hallucinatedApiRule.check(file, project)
    expect(findings).toHaveLength(1)
    expect(findings[0].message).toContain('.includes()')
  })

  it('detects .substr()', () => {
    const file = makeFile(`const sub = str.substr(0, 5)`)
    const findings = hallucinatedApiRule.check(file, project)
    expect(findings).toHaveLength(1)
    expect(findings[0].message).toContain('.substring()')
  })

  it('detects .trimLeft()', () => {
    const file = makeFile(`const trimmed = str.trimLeft()`)
    const findings = hallucinatedApiRule.check(file, project)
    expect(findings).toHaveLength(1)
    expect(findings[0].message).toContain('.trimStart()')
  })

  it('detects response.body.json()', () => {
    const file = makeFile(`const data = response.body.json()`)
    const findings = hallucinatedApiRule.check(file, project)
    expect(findings).toHaveLength(1)
    expect(findings[0].message).toContain('response.json()')
  })

  it('ignores correct APIs', () => {
    const file = makeFile(`const flat = arr.flat()\nconst has = arr.includes(x)`)
    const findings = hallucinatedApiRule.check(file, project)
    expect(findings).toHaveLength(0)
  })

  // Framework whitelisting tests
  it('skips .contains() when Prisma is detected', () => {
    const prismaProject = makeProject({ detectedFrameworks: new Set(['prisma']) })
    const file = makeFile(`const users = await prisma.user.findMany({ where: { name: { contains: 'test' } } })`)
    const findings = hallucinatedApiRule.check(file, prismaProject)
    expect(findings).toHaveLength(0)
  })

  it('skips .contains() when Supabase is detected', () => {
    const supabaseProject = makeProject({ detectedFrameworks: new Set(['supabase']) })
    const file = makeFile(`const { data } = await supabase.from('items').select().contains('tags', ['a'])`)
    const findings = hallucinatedApiRule.check(file, supabaseProject)
    expect(findings).toHaveLength(0)
  })

  it('skips .flatten() when lodash is detected', () => {
    const lodashProject = makeProject({ detectedFrameworks: new Set(['lodash']) })
    const file = makeFile(`const flat = _.flatten(arr)`)
    const findings = hallucinatedApiRule.check(file, lodashProject)
    expect(findings).toHaveLength(0)
  })

  it('still flags .substr() even with Prisma', () => {
    const prismaProject = makeProject({ detectedFrameworks: new Set(['prisma']) })
    const file = makeFile(`const sub = str.substr(0, 5)`)
    const findings = hallucinatedApiRule.check(file, prismaProject)
    expect(findings).toHaveLength(1)
  })

  it('still flags .contains() without any framework', () => {
    const file = makeFile(`if (arr.contains(x)) {}`)
    const findings = hallucinatedApiRule.check(file, project)
    expect(findings).toHaveLength(1)
  })
})
