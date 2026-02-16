import { describe, it, expect } from 'vitest'
import { corsConfigRule } from '../../src/rules/cors-config.js'
import { makeFile, makeProject } from '../helpers.js'

const project = makeProject()

describe('cors-config rule', () => {
  it('flags Access-Control-Allow-Origin: *', () => {
    const file = makeFile(`res.setHeader("Access-Control-Allow-Origin", "*")`)
    const findings = corsConfigRule.check(file, project)
    expect(findings).toHaveLength(1)
    expect(findings[0].message).toContain('any domain')
  })

  it('flags cors() with no args', () => {
    const file = makeFile(`app.use(cors())`)
    const findings = corsConfigRule.check(file, project)
    expect(findings).toHaveLength(1)
    expect(findings[0].message).toContain('all origins')
  })

  it('flags origin: "*"', () => {
    const file = makeFile(`const config = { origin: "*" }`)
    const findings = corsConfigRule.check(file, project)
    expect(findings).toHaveLength(1)
  })

  it('flags origin: true', () => {
    const file = makeFile(`const config = { origin: true }`)
    const findings = corsConfigRule.check(file, project)
    expect(findings).toHaveLength(1)
    expect(findings[0].message).toContain('mirrors')
  })

  it('passes cors() with config', () => {
    const file = makeFile(`app.use(cors({ origin: 'https://example.com' }))`)
    const findings = corsConfigRule.check(file, project)
    expect(findings).toHaveLength(0)
  })

  it('passes specific origin', () => {
    const file = makeFile(`res.setHeader("Access-Control-Allow-Origin", "https://myapp.com")`)
    const findings = corsConfigRule.check(file, project)
    expect(findings).toHaveLength(0)
  })

  it('skips comments', () => {
    const file = makeFile(`// res.setHeader("Access-Control-Allow-Origin", "*")`)
    const findings = corsConfigRule.check(file, project)
    expect(findings).toHaveLength(0)
  })

  it('skips block comments', () => {
    const file = makeFile(`/*\ncors()\n*/`)
    const findings = corsConfigRule.check(file, project)
    expect(findings).toHaveLength(0)
  })
})
