import { describe, it, expect } from 'vitest'
import { errorHandlingRule } from '../../src/rules/error-handling.js'
import { makeFile, makeProject } from '../helpers.js'

const project = makeProject()

describe('error-handling rule', () => {
  it('flags API route without try/catch', () => {
    const file = makeFile(
      `export async function GET() {\n  return Response.json({})\n}`,
      { relativePath: 'app/api/data/route.ts' },
    )
    const findings = errorHandlingRule.check(file, project)
    expect(findings).toHaveLength(1)
    expect(findings[0].message).toContain('no try/catch')
  })

  it('passes API route with try/catch', () => {
    const file = makeFile(
      `export async function GET() {\n  try {\n    return Response.json({})\n  } catch (e) {\n    return Response.json({ error: e })\n  }\n}`,
      { relativePath: 'app/api/data/route.ts' },
    )
    const findings = errorHandlingRule.check(file, project)
    expect(findings).toHaveLength(0)
  })

  it('skips non-API files', () => {
    const file = makeFile(
      `export function doThing() {\n  return 42\n}`,
      { relativePath: 'src/utils/helper.ts' },
    )
    const findings = errorHandlingRule.check(file, project)
    expect(findings).toHaveLength(0)
  })

  it('reports correct handler line', () => {
    const file = makeFile(
      `import { NextResponse } from 'next/server'\n\nexport async function POST() {\n  return NextResponse.json({})\n}`,
      { relativePath: 'app/api/submit/route.ts' },
    )
    const findings = errorHandlingRule.check(file, project)
    expect(findings[0].line).toBe(3)
  })

  it('passes API route using Inngest serve()', () => {
    const file = makeFile(
      `import { serve } from 'inngest/next'\nimport { inngest } from '@/inngest'\nexport const { GET, POST } = serve({ client: inngest, functions: [] })`,
      { relativePath: 'app/api/inngest/route.ts' },
    )
    const findings = errorHandlingRule.check(file, project)
    expect(findings).toHaveLength(0)
  })

  it('passes API route using tRPC handler', () => {
    const file = makeFile(
      `import { fetchRequestHandler } from '@trpc/server/adapters/fetch'\nexport function GET(req) { return fetchRequestHandler({ req, router }) }`,
      { relativePath: 'app/api/trpc/route.ts' },
    )
    const findings = errorHandlingRule.check(file, project)
    expect(findings).toHaveLength(0)
  })

  it('flags custom handler without try/catch', () => {
    const file = makeFile(
      `export async function POST(req) {\n  const data = await req.json()\n  await db.insert(data)\n  return Response.json({ ok: true })\n}`,
      { relativePath: 'app/api/custom/route.ts' },
    )
    const findings = errorHandlingRule.check(file, project)
    expect(findings).toHaveLength(1)
  })

  it('passes API route with try/catch even if catch is empty', () => {
    const file = makeFile(
      `export async function GET() {\n  try { doThing() } catch (e) {}\n}`,
      { relativePath: 'app/api/data/route.ts' },
    )
    // error-handling only checks try/catch exists; shallow-catch handles catch quality
    const findings = errorHandlingRule.check(file, project)
    expect(findings).toHaveLength(0)
  })

  it('flags pages/api route without try/catch', () => {
    const file = makeFile(
      `export default function handler(req, res) {\n  res.json({ ok: true })\n}`,
      { relativePath: 'pages/api/data.ts' },
    )
    const findings = errorHandlingRule.check(file, project)
    expect(findings).toHaveLength(1)
  })
})
