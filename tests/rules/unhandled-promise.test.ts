import { describe, it, expect } from 'vitest'
import { unhandledPromiseRule } from '../../src/rules/unhandled-promise.js'
import { makeFile, makeProject } from '../helpers.js'

const project = makeProject()

describe('unhandled-promise rule', () => {
  it('detects fire-and-forget fetch', () => {
    const file = makeFile(`fetch('/api/track')`)
    const findings = unhandledPromiseRule.check(file, project)
    expect(findings).toHaveLength(1)
    expect(findings[0].message).toContain('promise')
  })

  it('detects fire-and-forget prisma call', () => {
    const file = makeFile(`prisma.log.create({ data: { msg: 'hi' } })`)
    const findings = unhandledPromiseRule.check(file, project)
    expect(findings).toHaveLength(1)
  })

  it('ignores awaited calls', () => {
    const file = makeFile(`const res = await fetch('/api/users')`)
    const findings = unhandledPromiseRule.check(file, project)
    expect(findings).toHaveLength(0)
  })

  it('ignores assigned calls', () => {
    const file = makeFile(`const promise = fetch('/api/users')`)
    const findings = unhandledPromiseRule.check(file, project)
    expect(findings).toHaveLength(0)
  })

  it('ignores .then() chains', () => {
    const file = makeFile(`fetch('/api').then(r => r.json())`)
    const findings = unhandledPromiseRule.check(file, project)
    expect(findings).toHaveLength(0)
  })

  it('ignores multiline await chains', () => {
    const file = makeFile([
      'await supabase',
      '  .from("users")',
      '  .update({ name: "test" })',
      '  .eq("id", userId)',
    ].join('\n'))
    const findings = unhandledPromiseRule.check(file, project)
    expect(findings).toHaveLength(0)
  })

  it('ignores calls inside Promise.all', () => {
    const file = makeFile([
      'const [a, b] = await Promise.all([',
      '  fetch("/api/a"),',
      '  fetch("/api/b"),',
      '])',
    ].join('\n'))
    const findings = unhandledPromiseRule.check(file, project)
    expect(findings).toHaveLength(0)
  })

  it('allows void fetch() (explicit discard)', () => {
    const file = makeFile(`void fetch('/api/track')`)
    const findings = unhandledPromiseRule.check(file, project)
    expect(findings).toHaveLength(0)
  })

  it('flags standalone prisma delete without handling', () => {
    const file = makeFile(`prisma.event.delete({ where: { id } })`)
    const findings = unhandledPromiseRule.check(file, project)
    expect(findings).toHaveLength(1)
  })

  it('allows .then().catch() chain', () => {
    const file = makeFile(`fetch('/api/data').then(r => r.json()).catch(console.error)`)
    const findings = unhandledPromiseRule.check(file, project)
    expect(findings).toHaveLength(0)
  })

  it('allows return fetch()', () => {
    const file = makeFile(`return fetch('/api/data')`)
    const findings = unhandledPromiseRule.check(file, project)
    expect(findings).toHaveLength(0)
  })
})
