import { describe, it, expect } from 'vitest'
import { inputValidationRule } from '../../src/rules/input-validation.js'
import { makeFile, makeProject } from '../helpers.js'

const project = makeProject()

describe('input-validation rule', () => {
  it('flags req.body without validation', () => {
    const file = makeFile(
      `export async function POST(req) {\n  const data = req.body\n}`,
      { relativePath: 'app/api/submit/route.ts' },
    )
    const findings = inputValidationRule.check(file, project)
    expect(findings).toHaveLength(1)
    expect(findings[0].message).toContain('validation')
  })

  it('flags request.json() without validation', () => {
    const file = makeFile(
      `export async function POST(request) {\n  const data = await request.json()\n}`,
      { relativePath: 'app/api/submit/route.ts' },
    )
    const findings = inputValidationRule.check(file, project)
    expect(findings).toHaveLength(1)
  })

  it('passes when Zod validation present', () => {
    const file = makeFile(
      `import { z } from 'zod'\nconst schema = z.object({ name: z.string() })\nexport async function POST(req) {\n  const data = schema.parse(await req.json())\n}`,
      { relativePath: 'app/api/submit/route.ts' },
    )
    const findings = inputValidationRule.check(file, project)
    expect(findings).toHaveLength(0)
  })

  it('passes when .safeParse used', () => {
    const file = makeFile(
      `export async function POST(req) {\n  const result = schema.safeParse(req.body)\n}`,
      { relativePath: 'app/api/submit/route.ts' },
    )
    const findings = inputValidationRule.check(file, project)
    expect(findings).toHaveLength(0)
  })

  it('passes when .validate used (Yup)', () => {
    const file = makeFile(
      `export async function POST(req) {\n  await schema.validate(req.body)\n}`,
      { relativePath: 'app/api/submit/route.ts' },
    )
    const findings = inputValidationRule.check(file, project)
    expect(findings).toHaveLength(0)
  })

  it('skips non-API files', () => {
    const file = makeFile(
      `const data = req.body`,
      { relativePath: 'src/utils/parser.ts' },
    )
    const findings = inputValidationRule.check(file, project)
    expect(findings).toHaveLength(0)
  })

  it('skips routes that do not access body', () => {
    const file = makeFile(
      `export async function GET() {\n  return Response.json({ ok: true })\n}`,
      { relativePath: 'app/api/data/route.ts' },
    )
    const findings = inputValidationRule.check(file, project)
    expect(findings).toHaveLength(0)
  })
})
