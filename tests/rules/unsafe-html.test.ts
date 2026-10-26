import { describe, it, expect } from 'vitest'
import { unsafeHtmlRule } from '../../src/rules/unsafe-html.js'
import { makeFile, makeProject } from '../helpers.js'

const project = makeProject()
// A .tsx path, so the file parses with JSX and the rule takes its AST path
const TSX = { relativePath: 'components/post.tsx' }

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

  // AST improvement: multi-line dangerouslySetInnerHTML with JSON.stringify beyond 2-line window
  it('AST: skips dangerouslySetInnerHTML with JSON.stringify beyond 2-line window', () => {
    const file = makeFile([
      '<script',
      '  type="application/ld+json"',
      '  dangerouslySetInnerHTML={{',
      '    __html:',
      '      JSON.stringify(',
      '        schema',
      '      )',
      '  }}',
      '/>',
    ].join('\n'), { ext: 'tsx' })
    const findings = unsafeHtmlRule.check(file, project)
    expect(findings).toHaveLength(0)
  })

  // AST: regex fallback still works
  it('falls back to regex when AST is unavailable', () => {
    const file = makeFile(
      `<div dangerouslySetInnerHTML={{ __html: content }} />`,
      { ext: 'tsx', withAst: false },
    )
    const findings = unsafeHtmlRule.check(file, project)
    expect(findings).toHaveLength(1)
  })

  // The rule's own fix is DOMPurify.sanitize(html), so sanitized HTML must pass
  it('allows dangerouslySetInnerHTML wrapped in DOMPurify.sanitize()', () => {
    const file = makeFile(
      `<div dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(html) }} />`,
      TSX,
    )
    const findings = unsafeHtmlRule.check(file, project)
    expect(findings).toHaveLength(0)
  })

  it('allows other sanitizers: sanitize-html, js-xss', () => {
    const file = makeFile([
      '<div dangerouslySetInnerHTML={{ __html: sanitizeHtml(post.body) }} />',
      '<div dangerouslySetInnerHTML={{ __html: xss(comment) }} />',
    ].join('\n'), TSX)
    const findings = unsafeHtmlRule.check(file, project)
    expect(findings).toHaveLength(0)
  })

  it('allows a variable that holds sanitized HTML', () => {
    const file = makeFile([
      'const clean = DOMPurify.sanitize(post.body)',
      'export const Post = () => <article dangerouslySetInnerHTML={{ __html: clean }} />',
    ].join('\n'), TSX)
    expect(file.ast).toBeTruthy()
    const findings = unsafeHtmlRule.check(file, project)
    expect(findings).toHaveLength(0)
  })

  it('allows innerHTML assigned sanitized HTML', () => {
    const file = makeFile(`el.innerHTML = DOMPurify.sanitize(html)`, TSX)
    const findings = unsafeHtmlRule.check(file, project)
    expect(findings).toHaveLength(0)
  })

  it('still flags HTML that is only partly sanitized', () => {
    const file = makeFile(
      `<div dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(intro) + body }} />`,
      TSX,
    )
    const findings = unsafeHtmlRule.check(file, project)
    expect(findings).toHaveLength(1)
  })

  it('falls back to regex: allows DOMPurify.sanitize() without an AST', () => {
    const file = makeFile([
      '<div dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(html) }} />',
      'el.innerHTML = DOMPurify.sanitize(html)',
    ].join('\n'), { ext: 'tsx', withAst: false })
    const findings = unsafeHtmlRule.check(file, project)
    expect(findings).toHaveLength(0)
  })
})
