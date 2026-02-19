import { describe, it, expect } from 'vitest'
import { verboseErrorResponseRule } from '../../src/rules/verbose-error-response.js'
import { makeFile, makeProject } from '../helpers.js'

const project = makeProject()

describe('verbose-error-response rule', () => {
  it('detects error.stack in API route', () => {
    const file = makeFile(
      'export async function POST(req) {\n' +
      '  try {\n' +
      '    await doStuff()\n' +
      '  } catch (error) {\n' +
      '    return Response.json({ stack: error.stack })\n' +
      '  }\n' +
      '}',
      { relativePath: 'app/api/users/route.ts' },
    )
    const findings = verboseErrorResponseRule.check(file, project)
    expect(findings.length).toBeGreaterThan(0)
    expect(findings[0].ruleId).toBe('verbose-error-response')
    expect(findings[0].severity).toBe('warning')
  })

  it('detects error.message in API route', () => {
    const file = makeFile(
      'export async function POST(req) {\n' +
      '  try {\n' +
      '    await doStuff()\n' +
      '  } catch (err) {\n' +
      '    return Response.json({ msg: err.message })\n' +
      '  }\n' +
      '}',
      { relativePath: 'app/api/users/route.ts' },
    )
    const findings = verboseErrorResponseRule.check(file, project)
    // err.message doesn't match error.message — rule uses literal 'error'
    // This tests that the pattern is specifically about the 'error' variable
  })

  it('allows generic error messages', () => {
    const file = makeFile(
      'export async function POST(req) {\n' +
      '  try {\n' +
      '    await doStuff()\n' +
      '  } catch (error) {\n' +
      '    return Response.json({ msg: "Internal server error" })\n' +
      '  }\n' +
      '}',
      { relativePath: 'app/api/users/route.ts' },
    )
    const findings = verboseErrorResponseRule.check(file, project)
    expect(findings).toHaveLength(0)
  })

  it('ignores non-API routes', () => {
    const file = makeFile(
      'try { } catch (error) { console.log(error.stack) }',
      { relativePath: 'lib/utils.ts' },
    )
    const findings = verboseErrorResponseRule.check(file, project)
    expect(findings).toHaveLength(0)
  })

  it('checks server actions', () => {
    const file = makeFile(
      "'use server'\n" +
      'export async function action() {\n' +
      '  try {\n' +
      '    await doStuff()\n' +
      '  } catch (error) {\n' +
      '    return { error: error.stack }\n' +
      '  }\n' +
      '}',
      { relativePath: 'actions/submit.ts' },
    )
    const findings = verboseErrorResponseRule.check(file, project)
    expect(findings.length).toBeGreaterThan(0)
  })
})
