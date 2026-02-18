import { describe, it, expect } from 'vitest'
import { comprehensionDebtRule } from '../../src/rules/comprehension-debt.js'
import { makeFile, makeProject } from '../helpers.js'

const project = makeProject()

describe('comprehension-debt rule', () => {
  it('flags function with too many parameters', () => {
    const file = makeFile(`export function create(a: string, b: string, c: number, d: boolean, e: string, f: number) {\n  return { a, b, c, d, e, f }\n}`)
    const findings = comprehensionDebtRule.check(file, project)
    expect(findings.some(f => f.message.includes('6 parameters'))).toBe(true)
  })

  it('allows function with 5 parameters', () => {
    const file = makeFile(`export function create(a: string, b: string, c: number, d: boolean, e: string) {\n  return { a, b, c, d, e }\n}`)
    const findings = comprehensionDebtRule.check(file, project)
    expect(findings.some(f => f.message.includes('parameters'))).toBe(false)
  })

  it('flags long function (>80 lines)', () => {
    const body = Array.from({ length: 82 }, (_, i) => `  const x${i} = ${i}`).join('\n')
    const file = makeFile(`export function longFn() {\n${body}\n}`)
    const findings = comprehensionDebtRule.check(file, project)
    expect(findings.some(f => f.message.includes('lines long'))).toBe(true)
  })

  it('allows function under 80 lines', () => {
    const body = Array.from({ length: 50 }, (_, i) => `  const x${i} = ${i}`).join('\n')
    const file = makeFile(`export function shortFn() {\n${body}\n}`)
    const findings = comprehensionDebtRule.check(file, project)
    expect(findings.some(f => f.message.includes('lines long'))).toBe(false)
  })

  it('flags deeply nested function', () => {
    const file = makeFile([
      'export function deepFn() {',
      '  if (a) {',
      '    if (b) {',
      '      if (c) {',
      '        if (d) {',
      '          if (e) {',
      '            if (f) {',
      '              doStuff()',
      '            }',
      '          }',
      '        }',
      '      }',
      '    }',
      '  }',
      '}',
    ].join('\n'))
    const findings = comprehensionDebtRule.check(file, project)
    expect(findings.some(f => f.message.includes('nesting depth'))).toBe(true)
  })

  it('skips content/blog files', () => {
    const body = Array.from({ length: 300 }, (_, i) => `  <p>Paragraph ${i}</p>`).join('\n')
    const file = makeFile(`export function BlogPost() {\n  return (\n${body}\n  )\n}`, { relativePath: 'src/content/blog/my-post.tsx', ext: 'tsx' })
    const findings = comprehensionDebtRule.check(file, project)
    expect(findings).toHaveLength(0)
  })

  it('skips legal page files', () => {
    const body = Array.from({ length: 200 }, (_, i) => `  <p>Section ${i}</p>`).join('\n')
    const file = makeFile(`export function PrivacyPage() {\n  return (\n${body}\n  )\n}`, { relativePath: 'app/(legal)/privacy/page.tsx', ext: 'tsx' })
    const findings = comprehensionDebtRule.check(file, project)
    expect(findings).toHaveLength(0)
  })

  it('skips test files', () => {
    const body = Array.from({ length: 82 }, (_, i) => `  const x${i} = ${i}`).join('\n')
    const file = makeFile(`export function longFn() {\n${body}\n}`, { relativePath: '__tests__/foo.ts' })
    const findings = comprehensionDebtRule.check(file, project)
    expect(findings).toHaveLength(0)
  })

  it('returns empty for clean code', () => {
    const file = makeFile(`export function add(a: number, b: number) {\n  return a + b\n}`)
    const findings = comprehensionDebtRule.check(file, project)
    expect(findings).toHaveLength(0)
  })
})
