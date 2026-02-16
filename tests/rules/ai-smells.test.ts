import { describe, it, expect } from 'vitest'
import { aiSmellsRule } from '../../src/rules/ai-smells.js'
import { makeFile, makeProject } from '../helpers.js'

const project = makeProject()

describe('ai-smells rule', () => {
  describe('TODO/FIXME comments', () => {
    it('flags TODO comment', () => {
      const file = makeFile(`// TODO: implement this`)
      const findings = aiSmellsRule.check(file, project)
      expect(findings).toHaveLength(1)
      expect(findings[0].message).toContain('TODO')
      expect(findings[0].message).toContain('implement this')
    })

    it('flags FIXME comment', () => {
      const file = makeFile(`// FIXME: broken logic`)
      const findings = aiSmellsRule.check(file, project)
      expect(findings).toHaveLength(1)
      expect(findings[0].message).toContain('FIXME')
    })

    it('flags HACK comment', () => {
      const file = makeFile(`// HACK workaround for bug`)
      const findings = aiSmellsRule.check(file, project)
      expect(findings).toHaveLength(1)
    })

    it('flags TODO with no description', () => {
      const file = makeFile(`// TODO`)
      const findings = aiSmellsRule.check(file, project)
      expect(findings).toHaveLength(1)
      expect(findings[0].message).toContain('(no description)')
    })
  })

  describe('placeholder functions', () => {
    it('flags throw new Error("not implemented")', () => {
      const file = makeFile(`function doThing() {\n  throw new Error("not implemented")\n}`)
      const findings = aiSmellsRule.check(file, project)
      expect(findings.some(f => f.message.includes('not implemented'))).toBe(true)
    })

    it('is case-insensitive', () => {
      const file = makeFile(`throw new Error("Not Implemented")`)
      const findings = aiSmellsRule.check(file, project)
      expect(findings.some(f => f.message.includes('not implemented'))).toBe(true)
    })
  })

  describe('console.log spam', () => {
    it('flags more than 5 console.log statements', () => {
      const lines = Array.from({ length: 7 }, (_, i) => `console.log("debug ${i}")`)
      const file = makeFile(lines.join('\n'))
      const findings = aiSmellsRule.check(file, project)
      expect(findings.some(f => f.message.includes('console.log'))).toBe(true)
    })

    it('allows up to 5 console.log', () => {
      const lines = Array.from({ length: 5 }, (_, i) => `console.log("${i}")`)
      const file = makeFile(lines.join('\n'))
      const findings = aiSmellsRule.check(file, project)
      expect(findings.some(f => f.message.includes('console.log'))).toBe(false)
    })
  })

  describe('any type abuse', () => {
    it('flags more than 5 any types', () => {
      const lines = Array.from({ length: 7 }, (_, i) => `const x${i}: any = null`)
      const file = makeFile(lines.join('\n'))
      const findings = aiSmellsRule.check(file, project)
      expect(findings.some(f => f.message.includes('"any" type'))).toBe(true)
    })

    it('allows up to 5 any types', () => {
      const lines = Array.from({ length: 5 }, (_, i) => `const x${i}: any = null`)
      const file = makeFile(lines.join('\n'))
      const findings = aiSmellsRule.check(file, project)
      expect(findings.some(f => f.message.includes('"any" type'))).toBe(false)
    })

    it('counts "as any" casts', () => {
      const lines = Array.from({ length: 7 }, (_, i) => `const x${i} = foo as any`)
      const file = makeFile(lines.join('\n'))
      const findings = aiSmellsRule.check(file, project)
      expect(findings.some(f => f.message.includes('"any" type'))).toBe(true)
    })
  })

  describe('commented-out code', () => {
    it('flags 3+ consecutive lines of commented code', () => {
      const file = makeFile([
        '// const a = 1;',
        '// const b = 2;',
        '// const c = 3;',
      ].join('\n'))
      const findings = aiSmellsRule.check(file, project)
      expect(findings.some(f => f.message.includes('commented-out code'))).toBe(true)
    })

    it('allows 2 consecutive commented code lines', () => {
      const file = makeFile([
        '// const a = 1;',
        '// const b = 2;',
      ].join('\n'))
      const findings = aiSmellsRule.check(file, project)
      expect(findings.some(f => f.message.includes('commented-out code'))).toBe(false)
    })

    it('does not flag regular comments', () => {
      const file = makeFile([
        '// This is a description',
        '// of what the function does',
        '// and how to use it',
      ].join('\n'))
      const findings = aiSmellsRule.check(file, project)
      expect(findings.some(f => f.message.includes('commented-out code'))).toBe(false)
    })
  })

  it('returns empty for clean code', () => {
    const file = makeFile(`export function add(a: number, b: number): number {\n  return a + b\n}`)
    const findings = aiSmellsRule.check(file, project)
    expect(findings).toHaveLength(0)
  })
})
