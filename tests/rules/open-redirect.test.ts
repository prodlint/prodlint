import { describe, it, expect } from 'vitest'
import { openRedirectRule } from '../../src/rules/open-redirect.js'
import { makeFile, makeProject } from '../helpers.js'

const project = makeProject()

describe('open-redirect rule', () => {
  it('detects redirect(searchParams.get(...)) as warning', () => {
    const file = makeFile(`redirect(searchParams.get('returnTo'))`)
    const findings = openRedirectRule.check(file, project)
    expect(findings).toHaveLength(1)
    expect(findings[0].severity).toBe('warning')
  })

  it('detects redirect(req.query.x) as warning', () => {
    const file = makeFile(`redirect(req.query.returnTo)`)
    const findings = openRedirectRule.check(file, project)
    expect(findings).toHaveLength(1)
    expect(findings[0].severity).toBe('warning')
  })

  it('detects NextResponse.redirect with searchParams as warning', () => {
    const file = makeFile(`NextResponse.redirect(new URL(searchParams.get('next'), request.url))`)
    const findings = openRedirectRule.check(file, project)
    expect(findings).toHaveLength(1)
    expect(findings[0].severity).toBe('warning')
  })

  it('detects redirect(returnUrl) as warning', () => {
    const file = makeFile(`redirect(returnUrl)`)
    const findings = openRedirectRule.check(file, project)
    expect(findings).toHaveLength(1)
    expect(findings[0].severity).toBe('warning')
    expect(findings[0].message).toContain('verify')
  })

  it('detects redirect(callbackUrl) as warning', () => {
    const file = makeFile(`redirect(callbackUrl)`)
    const findings = openRedirectRule.check(file, project)
    expect(findings).toHaveLength(1)
    expect(findings[0].severity).toBe('warning')
  })

  it('ignores safe string literal redirects', () => {
    const file = makeFile(`redirect('/dashboard')`)
    const findings = openRedirectRule.check(file, project)
    expect(findings).toHaveLength(0)
  })

  it('ignores redirect with non-suspicious variable names', () => {
    const file = makeFile(`redirect(dashboardPath)`)
    const findings = openRedirectRule.check(file, project)
    expect(findings).toHaveLength(0)
  })

  it('ignores redirects in comments', () => {
    const file = makeFile(`// redirect(searchParams.get('returnTo'))`)
    const findings = openRedirectRule.check(file, project)
    expect(findings).toHaveLength(0)
  })

  it('detects redirect(redirect) variable', () => {
    const file = makeFile(`redirect(redirect)`)
    const findings = openRedirectRule.check(file, project)
    expect(findings).toHaveLength(1)
  })

  it('detects redirect(goto) variable', () => {
    const file = makeFile(`redirect(goto)`)
    const findings = openRedirectRule.check(file, project)
    expect(findings).toHaveLength(1)
  })

  it('detects redirect(target) variable', () => {
    const file = makeFile(`redirect(target)`)
    const findings = openRedirectRule.check(file, project)
    expect(findings).toHaveLength(1)
  })
})
