import { describe, it, expect } from 'vitest'
import { authChecksRule } from '../../src/rules/auth-checks.js'
import { makeFile, makeProject } from '../helpers.js'

describe('auth-checks rule', () => {
  it('flags API route without auth', () => {
    const file = makeFile(
      `export async function GET() {\n  return Response.json({ ok: true })\n}`,
      { relativePath: 'app/api/users/route.ts' },
    )
    const project = makeProject()
    const findings = authChecksRule.check(file, project)
    expect(findings).toHaveLength(1)
    expect(findings[0].severity).toBe('critical')
  })

  it('passes when getServerSession is used', () => {
    const file = makeFile(
      `import { getServerSession } from 'next-auth'\nexport async function GET() {\n  const session = await getServerSession()\n}`,
      { relativePath: 'app/api/users/route.ts' },
    )
    const findings = authChecksRule.check(file, makeProject())
    expect(findings).toHaveLength(0)
  })

  it('passes when auth() is used', () => {
    const file = makeFile(
      `export async function GET() {\n  const session = await auth()\n}`,
      { relativePath: 'app/api/users/route.ts' },
    )
    const findings = authChecksRule.check(file, makeProject())
    expect(findings).toHaveLength(0)
  })

  it('exempts auth routes', () => {
    const file = makeFile(
      `export async function POST() {}`,
      { relativePath: 'app/api/auth/login/route.ts' },
    )
    const findings = authChecksRule.check(file, makeProject())
    expect(findings).toHaveLength(0)
  })

  it('exempts webhook routes', () => {
    const file = makeFile(
      `export async function POST() {}`,
      { relativePath: 'app/api/webhook/route.ts' },
    )
    const findings = authChecksRule.check(file, makeProject())
    expect(findings).toHaveLength(0)
  })

  it('exempts health check routes', () => {
    const file = makeFile(
      `export async function GET() {}`,
      { relativePath: 'app/api/health/route.ts' },
    )
    const findings = authChecksRule.check(file, makeProject())
    expect(findings).toHaveLength(0)
  })

  it('exempts stripe routes', () => {
    const file = makeFile(
      `export async function POST() {}`,
      { relativePath: 'app/api/stripe/webhook/route.ts' },
    )
    const findings = authChecksRule.check(file, makeProject())
    expect(findings).toHaveLength(0)
  })

  it('downgrades to info when middleware auth detected', () => {
    const file = makeFile(
      `export async function GET() {\n  return Response.json({ ok: true })\n}`,
      { relativePath: 'app/api/users/route.ts' },
    )
    const project = makeProject({ hasAuthMiddleware: true })
    const findings = authChecksRule.check(file, project)
    expect(findings).toHaveLength(1)
    expect(findings[0].severity).toBe('info')
    expect(findings[0].message).toContain('middleware')
  })

  it('skips non-API files', () => {
    const file = makeFile(
      `export function Page() { return <div>Hello</div> }`,
      { relativePath: 'app/page.tsx' },
    )
    const findings = authChecksRule.check(file, makeProject())
    expect(findings).toHaveLength(0)
  })

  it('reports correct handler line', () => {
    const file = makeFile(
      `import { NextResponse } from 'next/server'\n\nexport async function GET() {\n  return NextResponse.json({})\n}`,
      { relativePath: 'app/api/data/route.ts' },
    )
    const findings = authChecksRule.check(file, makeProject())
    expect(findings[0].line).toBe(3)
  })

  it('works with Pages Router API routes', () => {
    const file = makeFile(
      `export default function handler(req, res) {\n  res.json({ ok: true })\n}`,
      { relativePath: 'pages/api/users.ts' },
    )
    const findings = authChecksRule.check(file, makeProject())
    expect(findings).toHaveLength(1)
  })
})
