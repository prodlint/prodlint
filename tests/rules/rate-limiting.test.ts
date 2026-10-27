import { describe, it, expect } from 'vitest'
import { rateLimitingRule } from '../../src/rules/rate-limiting.js'
import { makeFile, makeProject, scanFiles } from '../helpers.js'

const project = makeProject()

describe('rate-limiting rule', () => {
  it('flags API route without rate limiting as info', () => {
    const file = makeFile(
      `export async function POST() {\n  return Response.json({ ok: true })\n}`,
      { relativePath: 'app/api/submit/route.ts' },
    )
    const findings = rateLimitingRule.check(file, project)
    expect(findings).toHaveLength(1)
    expect(findings[0].severity).toBe('info')
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

  it('skips all routes when project has centralized rate limiting', () => {
    const file = makeFile(
      `export async function POST() {\n  return Response.json({ ok: true })\n}`,
      { relativePath: 'app/api/submit/route.ts' },
    )
    const projectWithRL = makeProject({ hasRateLimiting: true })
    const findings = rateLimitingRule.check(file, projectWithRL)
    expect(findings).toHaveLength(0)
  })

  // Through the scanner: Next.js 16 renamed middleware.ts to proxy.ts
  it('skips all routes when a Next.js 16 proxy rate-limits', async () => {
    const route = { 'app/api/chat/route.ts': 'export async function POST() {\n  return Response.json({ ok: true })\n}\n' }
    const proxy = `import { Ratelimit } from '@upstash/ratelimit'
import { Redis } from '@upstash/redis'
import { NextResponse, type NextRequest } from 'next/server'

const ratelimit = new Ratelimit({ redis: Redis.fromEnv(), limiter: Ratelimit.slidingWindow(10, '10 s') })

export async function proxy(request: NextRequest) {
  const { success } = await ratelimit.limit(request.headers.get('x-forwarded-for') ?? 'anonymous')
  return success ? NextResponse.next() : new NextResponse('Too many requests', { status: 429 })
}
`
    const findings = async (files: Record<string, string>) =>
      (await scanFiles(files)).findings.filter(f => f.ruleId === 'rate-limiting')

    expect(await findings(route)).toHaveLength(1)
    expect(await findings({ ...route, 'proxy.ts': proxy })).toHaveLength(0)
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
