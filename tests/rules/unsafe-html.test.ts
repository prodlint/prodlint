import { describe, it, expect } from 'vitest'
import { unsafeHtmlRule } from '../../src/rules/unsafe-html.js'
import { makeFile, makeProject } from '../helpers.js'

const project = makeProject()

describe('unsafe-html rule', () => {
  it('flags dangerouslySetInnerHTML=', () => {
    const file = makeFile(`<div dangerouslySetInnerHTML={{ __html: content }} />`, { ext: 'tsx' })
    const findings = unsafeHtmlRule.check(file, project)
    expect(findings).toHaveLength(1)
    expect(findings[0].message).toContain('XSS')
  })

  it('flags dangerouslySetInnerHTML: in object', () => {
    const file = makeFile(`const props = { dangerouslySetInnerHTML: { __html: html } }`, { ext: 'tsx' })
    const findings = unsafeHtmlRule.check(file, project)
    expect(findings).toHaveLength(1)
  })

  it('flags .innerHTML =', () => {
    const file = makeFile(`element.innerHTML = userInput`, { ext: 'ts' })
    const findings = unsafeHtmlRule.check(file, project)
    expect(findings).toHaveLength(1)
    expect(findings[0].message).toContain('innerHTML')
  })

  it('does not flag innerHTML read', () => {
    const file = makeFile(`const html = element.innerHTML`, { ext: 'ts' })
    const findings = unsafeHtmlRule.check(file, project)
    expect(findings).toHaveLength(0)
  })

  it('skips comments', () => {
    const file = makeFile(`// dangerouslySetInnerHTML= something`, { ext: 'tsx' })
    const findings = unsafeHtmlRule.check(file, project)
    expect(findings).toHaveLength(0)
  })

  it('skips block comments', () => {
    const file = makeFile(`/*\nelement.innerHTML = bad\n*/`, { ext: 'ts' })
    const findings = unsafeHtmlRule.check(file, project)
    expect(findings).toHaveLength(0)
  })

  it('passes clean JSX', () => {
    const file = makeFile(`<div className="safe">{content}</div>`, { ext: 'tsx' })
    const findings = unsafeHtmlRule.check(file, project)
    expect(findings).toHaveLength(0)
  })

  it('skips dangerouslySetInnerHTML with JSON.stringify (same line)', () => {
    const file = makeFile(
      `<script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }} />`,
      { ext: 'tsx' },
    )
    const findings = unsafeHtmlRule.check(file, project)
    expect(findings).toHaveLength(0)
  })

  it('skips dangerouslySetInnerHTML with JSON.stringify (multi-line)', () => {
    const file = makeFile(
      `<script\n  type="application/ld+json"\n  dangerouslySetInnerHTML={{\n    __html: JSON.stringify(jsonLd)\n  }}\n/>`,
      { ext: 'tsx' },
    )
    const findings = unsafeHtmlRule.check(file, project)
    expect(findings).toHaveLength(0)
  })

  it('still flags dangerouslySetInnerHTML with variable content', () => {
    const file = makeFile(
      `<div dangerouslySetInnerHTML={{ __html: userContent }} />`,
      { ext: 'tsx' },
    )
    const findings = unsafeHtmlRule.check(file, project)
    expect(findings).toHaveLength(1)
  })

  it('still flags when unrelated JSON.stringify is nearby', () => {
    const file = makeFile(
      `<div dangerouslySetInnerHTML={{ __html: userInput }} />\nconst debug = JSON.stringify(state)`,
      { ext: 'tsx' },
    )
    const findings = unsafeHtmlRule.check(file, project)
    expect(findings).toHaveLength(1)
  })

  it('skips JSON-LD with __html: JSON.stringify split across lines', () => {
    const file = makeFile(
      `<script type="application/ld+json"\n  dangerouslySetInnerHTML={{ __html:\n    JSON.stringify(schema)\n  }} />`,
      { ext: 'tsx' },
    )
    const findings = unsafeHtmlRule.check(file, project)
    expect(findings).toHaveLength(0)
  })
})
