import { describe, it, expect } from 'vitest'
import { ssrfRiskRule } from '../../src/rules/ssrf-risk.js'
import { makeFile, makeProject } from '../helpers.js'

const project = makeProject()

describe('ssrf-risk rule', () => {
  it('detects fetch with req.body URL', () => {
    const file = makeFile(`export async function POST(req) {
  const { url } = await req.json()
  const res = await fetch(req.body.url)
}`, { relativePath: 'app/api/preview/route.ts' })
    const findings = ssrfRiskRule.check(file, project)
    expect(findings).toHaveLength(1)
    expect(findings[0].ruleId).toBe('ssrf-risk')
  })

  it('detects fetch with url variable in API route', () => {
    const file = makeFile(`export async function POST(req) {
  const { url } = await req.json()
  const res = await fetch(url)
}`, { relativePath: 'app/api/preview/route.ts' })
    const findings = ssrfRiskRule.check(file, project)
    expect(findings).toHaveLength(1)
  })

  it('allows fetch with validation', () => {
    const file = makeFile(`export async function POST(req) {
  const { url } = await req.json()
  const allowedHosts = ['api.example.com']
  const parsed = new URL(url)
  if (!allowedHosts.includes(parsed.hostname)) throw new Error()
  const res = await fetch(url)
}`, { relativePath: 'app/api/preview/route.ts' })
    const findings = ssrfRiskRule.check(file, project)
    expect(findings).toHaveLength(0)
  })

  it('ignores non-API files', () => {
    const file = makeFile(`const res = await fetch(url)`, { relativePath: 'lib/utils.ts' })
    const findings = ssrfRiskRule.check(file, project)
    expect(findings).toHaveLength(0)
  })

  it('checks server actions', () => {
    const file = makeFile(`'use server'
export async function fetchUrl(url) {
  const res = await fetch(url)
}`, { relativePath: 'actions/preview.ts' })
    const findings = ssrfRiskRule.check(file, project)
    expect(findings).toHaveLength(1)
  })

  // AST improvement: static string is safe
  it('AST: skips fetch("https://api.example.com/data") — static string', () => {
    const file = makeFile(`export async function GET() {
  const res = await fetch("https://api.example.com/data")
}`, { relativePath: 'app/api/data/route.ts' })
    const findings = ssrfRiskRule.check(file, project)
    expect(findings).toHaveLength(0)
  })

  // AST improvement: comment with "allowlist" doesn't suppress direct user input
  it('AST: flags fetch(req.body.url) even with "allowlist" in comment', () => {
    const file = makeFile(`export async function POST(req) {
  // TODO: add allowlist validation
  const { url } = await req.json()
  const res = await fetch(req.body.url)
}`, { relativePath: 'app/api/proxy/route.ts' })
    const findings = ssrfRiskRule.check(file, project)
    expect(findings).toHaveLength(1)
  })

  // AST: regex fallback still works
  it('falls back to regex when AST is unavailable', () => {
    const file = makeFile(`export async function POST(req) {
  const res = await fetch(req.body.url)
}`, { relativePath: 'app/api/preview/route.ts', withAst: false })
    const findings = ssrfRiskRule.check(file, project)
    expect(findings).toHaveLength(1)
  })
})
