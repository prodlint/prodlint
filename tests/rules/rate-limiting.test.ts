import { describe, it, expect } from 'vitest'
import { rateLimitingRule } from '../../src/rules/rate-limiting.js'
import { makeFile, makeProject } from '../helpers.js'

const project = makeProject()

describe('rate-limiting rule', () => {
  it('flags API route without rate limiting', () => {
    const file = makeFile(
      `export async function POST() {\n  return Response.json({ ok: true })\n}`,
      { relativePath: 'app/api/submit/route.ts' },
    )
    const findings = rateLimitingRule.check(file, project)
    expect(findings).toHaveLength(1)
  })

  it('passes when rateLimit is present', () => {
    const file = makeFile(
      `import { rateLimit } from '@/lib/rate-limit'\nexport async function POST() {\n  await rateLimit(req)\n}`,
      { relativePath: 'app/api/submit/route.ts' },
    )
    const findings = rateLimitingRule.check(file, project)
    expect(findings).toHaveLength(0)
  })

  it('passes when Upstash ratelimit is present', () => {
    const file = makeFile(
      `import { Ratelimit } from '@upstash/ratelimit'\nexport async function POST() {}`,
      { relativePath: 'app/api/submit/route.ts' },
    )
    const findings = rateLimitingRule.check(file, project)
    expect(findings).toHaveLength(0)
  })

  it('passes when throttle is present', () => {
    const file = makeFile(
      `const throttle = createThrottle()\nexport async function POST() {}`,
      { relativePath: 'app/api/submit/route.ts' },
    )
    const findings = rateLimitingRule.check(file, project)
    expect(findings).toHaveLength(0)
  })

  it('exempts health routes', () => {
    const file = makeFile(
      `export async function GET() { return Response.json({ ok: true }) }`,
      { relativePath: 'app/api/health/route.ts' },
    )
    const findings = rateLimitingRule.check(file, project)
    expect(findings).toHaveLength(0)
  })

  it('exempts webhook routes', () => {
    const file = makeFile(
      `export async function POST() {}`,
      { relativePath: 'app/api/webhook/route.ts' },
    )
    const findings = rateLimitingRule.check(file, project)
    expect(findings).toHaveLength(0)
  })

  it('exempts cron routes', () => {
    const file = makeFile(
      `export async function GET() {}`,
      { relativePath: 'app/api/cron/route.ts' },
    )
    const findings = rateLimitingRule.check(file, project)
    expect(findings).toHaveLength(0)
  })

  it('skips non-API files', () => {
    const file = makeFile(
      `export function Component() { return <div /> }`,
      { relativePath: 'app/page.tsx' },
    )
    const findings = rateLimitingRule.check(file, project)
    expect(findings).toHaveLength(0)
  })
})
