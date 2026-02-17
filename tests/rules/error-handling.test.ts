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
    const routeFinding = findings.find(f => f.message.includes('no try/catch'))
    expect(routeFinding).toBeDefined()
  })

  it('passes API route with try/catch', () => {
    const file = makeFile(
      `export async function GET() {\n  try {\n    return Response.json({})\n  } catch (e) {\n    return Response.json({ error: e })\n  }\n}`,
      { relativePath: 'app/api/data/route.ts' },
    )
    const findings = errorHandlingRule.check(file, project)
    const routeFinding = findings.find(f => f.message.includes('no try/catch'))
    expect(routeFinding).toBeUndefined()
  })

  it('flags single-line empty catch', () => {
    const file = makeFile(`try { doThing() } catch (e) {}`)
    const findings = errorHandlingRule.check(file, project)
    expect(findings.some(f => f.message.includes('Empty catch'))).toBe(true)
  })

  it('flags multi-line empty catch', () => {
    const file = makeFile(`try {\n  doThing()\n} catch (e) {\n}`)
    const findings = errorHandlingRule.check(file, project)
    expect(findings.some(f => f.message.includes('Empty catch'))).toBe(true)
  })

  it('passes catch with content', () => {
    const file = makeFile(`try {\n  doThing()\n} catch (e) {\n  console.error(e)\n}`)
    const findings = errorHandlingRule.check(file, project)
    expect(findings.some(f => f.message.includes('Empty catch'))).toBe(false)
  })

  it('skips empty catch in comments', () => {
    const file = makeFile(`// try { doThing() } catch (e) {}`)
    const findings = errorHandlingRule.check(file, project)
    expect(findings.some(f => f.message.includes('Empty catch'))).toBe(false)
  })

  it('skips non-API files for missing try/catch', () => {
    const file = makeFile(
      `export function doThing() {\n  return 42\n}`,
      { relativePath: 'src/utils/helper.ts' },
    )
    const findings = errorHandlingRule.check(file, project)
    expect(findings.some(f => f.message.includes('no try/catch'))).toBe(false)
  })

  it('reports correct handler line', () => {
    const file = makeFile(
      `import { NextResponse } from 'next/server'\n\nexport async function POST() {\n  return NextResponse.json({})\n}`,
      { relativePath: 'app/api/submit/route.ts' },
    )
    const findings = errorHandlingRule.check(file, project)
    const routeFinding = findings.find(f => f.message.includes('no try/catch'))
    expect(routeFinding?.line).toBe(3)
  })

  it('passes API route using Inngest serve()', () => {
    const file = makeFile(
      `import { serve } from 'inngest/next'\nimport { inngest } from '@/inngest'\nexport const { GET, POST } = serve({ client: inngest, functions: [] })`,
      { relativePath: 'app/api/inngest/route.ts' },
    )
    const findings = errorHandlingRule.check(file, project)
    expect(findings.some(f => f.message.includes('no try/catch'))).toBe(false)
  })

  it('passes API route using tRPC handler', () => {
    const file = makeFile(
      `import { fetchRequestHandler } from '@trpc/server/adapters/fetch'\nexport function GET(req) { return fetchRequestHandler({ req, router }) }`,
      { relativePath: 'app/api/trpc/route.ts' },
    )
    const findings = errorHandlingRule.check(file, project)
    expect(findings.some(f => f.message.includes('no try/catch'))).toBe(false)
  })

  it('still flags custom handler without try/catch', () => {
    const file = makeFile(
      `export async function POST(req) {\n  const data = await req.json()\n  await db.insert(data)\n  return Response.json({ ok: true })\n}`,
      { relativePath: 'app/api/custom/route.ts' },
    )
    const findings = errorHandlingRule.check(file, project)
    expect(findings.some(f => f.message.includes('no try/catch'))).toBe(true)
  })

  it('still flags empty catch in serve() file', () => {
    const file = makeFile(
      `import { serve } from 'inngest/next'\nexport const { GET, POST } = serve({ client: inngest, functions: [] })\nfunction helper() { try { x() } catch (e) {} }`,
      { relativePath: 'app/api/inngest/route.ts' },
    )
    const findings = errorHandlingRule.check(file, project)
    expect(findings.some(f => f.message.includes('Empty catch'))).toBe(true)
    expect(findings.some(f => f.message.includes('no try/catch'))).toBe(false)
  })
})
