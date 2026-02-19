import { describe, it, expect } from 'vitest'
import { evalInjectionRule } from '../../src/rules/eval-injection.js'
import { makeFile, makeProject } from '../helpers.js'

const project = makeProject()

describe('eval-injection rule', () => {
  it('detects eval()', () => {
    const file = makeFile(`const result = eval(userInput)`)
    const findings = evalInjectionRule.check(file, project)
    expect(findings).toHaveLength(1)
    expect(findings[0].severity).toBe('critical')
  })

  it('detects new Function()', () => {
    const file = makeFile(`const fn = new Function("return " + code)`)
    const findings = evalInjectionRule.check(file, project)
    expect(findings).toHaveLength(1)
  })

  it('detects setTimeout with string', () => {
    const file = makeFile(`setTimeout("alert('hello')", 1000)`)
    const findings = evalInjectionRule.check(file, project)
    expect(findings).toHaveLength(1)
  })

  it('detects setInterval with string', () => {
    const file = makeFile(`setInterval("doStuff()", 5000)`)
    const findings = evalInjectionRule.check(file, project)
    expect(findings).toHaveLength(1)
  })

  it('allows setTimeout with function', () => {
    const file = makeFile(`setTimeout(() => doStuff(), 1000)`)
    const findings = evalInjectionRule.check(file, project)
    expect(findings).toHaveLength(0)
  })

  it('ignores eval in comments', () => {
    const file = makeFile(`// eval(userInput)`)
    const findings = evalInjectionRule.check(file, project)
    expect(findings).toHaveLength(0)
  })

  it('skips test files', () => {
    const file = makeFile(`eval(code)`, { relativePath: 'tests/eval.test.ts' })
    const findings = evalInjectionRule.check(file, project)
    expect(findings).toHaveLength(0)
  })
})
