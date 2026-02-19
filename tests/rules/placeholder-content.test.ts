import { describe, it, expect } from 'vitest'
import { placeholderContentRule } from '../../src/rules/placeholder-content.js'
import { makeFile, makeProject } from '../helpers.js'

const project = makeProject()

describe('placeholder-content rule', () => {
  it('detects Lorem ipsum', () => {
    const file = makeFile(`const text = "Lorem ipsum dolor sit amet"`)
    const findings = placeholderContentRule.check(file, project)
    expect(findings).toHaveLength(1)
    expect(findings[0].message).toContain('Lorem ipsum')
  })

  it('detects placeholder emails', () => {
    const file = makeFile(`const email = "example@example.com"`)
    const findings = placeholderContentRule.check(file, project)
    expect(findings).toHaveLength(1)
    expect(findings[0].message).toContain('example@example.com')
  })

  it('detects placeholder names', () => {
    const file = makeFile(`const name = "John Doe"`)
    const findings = placeholderContentRule.check(file, project)
    expect(findings).toHaveLength(1)
    expect(findings[0].message).toContain('John Doe')
  })

  it('detects placeholder passwords', () => {
    const file = makeFile(`const pass = "password123"`)
    const findings = placeholderContentRule.check(file, project)
    expect(findings).toHaveLength(1)
  })

  it('skips test files', () => {
    const file = makeFile(`const email = "example@example.com"`, { relativePath: 'tests/auth.test.ts' })
    const findings = placeholderContentRule.check(file, project)
    expect(findings).toHaveLength(0)
  })

  it('skips comments', () => {
    const file = makeFile(`// example@example.com is the default`)
    const findings = placeholderContentRule.check(file, project)
    expect(findings).toHaveLength(0)
  })

  it('detects user@example.com', () => {
    const file = makeFile(`const email = "user@example.com"`)
    const findings = placeholderContentRule.check(file, project)
    expect(findings).toHaveLength(1)
  })

  it('detects test@test.com', () => {
    const file = makeFile(`const email = "test@test.com"`)
    const findings = placeholderContentRule.check(file, project)
    expect(findings).toHaveLength(1)
  })

  it('detects Jane Doe', () => {
    const file = makeFile(`const name = "Jane Doe"`)
    const findings = placeholderContentRule.check(file, project)
    expect(findings).toHaveLength(1)
  })

  it('detects changeme', () => {
    const file = makeFile(`const pass = "changeme"`)
    const findings = placeholderContentRule.check(file, project)
    expect(findings).toHaveLength(1)
  })

  it('detects your-api-key-here', () => {
    const file = makeFile(`const key = "your-api-key-here"`)
    const findings = placeholderContentRule.check(file, project)
    expect(findings).toHaveLength(1)
  })

  it('detects replace-with- prefix', () => {
    const file = makeFile(`const url = "replace-with-real-url"`)
    const findings = placeholderContentRule.check(file, project)
    expect(findings).toHaveLength(1)
  })

  it('detects xxx placeholder', () => {
    const file = makeFile(`const key = "xxxxxxx"`)
    const findings = placeholderContentRule.check(file, project)
    expect(findings).toHaveLength(1)
  })
})
