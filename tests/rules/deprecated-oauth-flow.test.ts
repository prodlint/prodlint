import { describe, it, expect } from 'vitest'
import { deprecatedOauthFlowRule } from '../../src/rules/deprecated-oauth-flow.js'
import { makeFile, makeProject } from '../helpers.js'

const project = makeProject()

describe('deprecated-oauth-flow rule', () => {
  it('detects response_type=token', () => {
    const file = makeFile(`const authUrl = \`\${base}?response_type=token&client_id=\${id}\``)
    const findings = deprecatedOauthFlowRule.check(file, project)
    expect(findings).toHaveLength(1)
    expect(findings[0].ruleId).toBe('deprecated-oauth-flow')
  })

  it('detects response_type: "token" in config', () => {
    const file = makeFile(`const config = { response_type: "token", client_id: "abc" }`)
    const findings = deprecatedOauthFlowRule.check(file, project)
    expect(findings).toHaveLength(1)
  })

  it('allows response_type=code', () => {
    const file = makeFile(`const authUrl = \`\${base}?response_type=code&client_id=\${id}\``)
    const findings = deprecatedOauthFlowRule.check(file, project)
    expect(findings).toHaveLength(0)
  })

  it('ignores comments', () => {
    const file = makeFile(`// response_type: "token"`)
    const findings = deprecatedOauthFlowRule.check(file, project)
    expect(findings).toHaveLength(0)
  })

  it('skips test files', () => {
    const file = makeFile(`const url = "?response_type=token"`, { relativePath: 'tests/oauth.test.ts' })
    const findings = deprecatedOauthFlowRule.check(file, project)
    expect(findings).toHaveLength(0)
  })
})
