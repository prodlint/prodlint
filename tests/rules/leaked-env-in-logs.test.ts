import { describe, it, expect } from 'vitest'
import { leakedEnvInLogsRule } from '../../src/rules/leaked-env-in-logs.js'
import { makeFile, makeProject } from '../helpers.js'

const project = makeProject()

describe('leaked-env-in-logs rule', () => {
  it('flags console.log with process.env', () => {
    const file = makeFile(`console.log("API Key:", process.env.API_KEY)`, { relativePath: 'src/app.ts' })
    const findings = leakedEnvInLogsRule.check(file, project)
    expect(findings).toHaveLength(1)
    expect(findings[0].message).toContain('process.env')
  })

  it('flags console.error with process.env', () => {
    const file = makeFile(`console.error("DB:", process.env.DATABASE_URL)`, { relativePath: 'src/db.ts' })
    const findings = leakedEnvInLogsRule.check(file, project)
    expect(findings).toHaveLength(1)
  })

  it('ignores console.log without process.env', () => {
    const file = makeFile(`console.log("Server started on port", port)`, { relativePath: 'src/app.ts' })
    const findings = leakedEnvInLogsRule.check(file, project)
    expect(findings).toHaveLength(0)
  })

  it('skips test files', () => {
    const file = makeFile(`console.log(process.env.TEST_VAR)`, { relativePath: 'tests/env.test.ts' })
    const findings = leakedEnvInLogsRule.check(file, project)
    expect(findings).toHaveLength(0)
  })

  it('skips script files', () => {
    const file = makeFile(`console.log(process.env.SEED_DATA)`, { relativePath: 'scripts/seed.ts' })
    const findings = leakedEnvInLogsRule.check(file, project)
    expect(findings).toHaveLength(0)
  })

  it('includes fix suggestion', () => {
    const file = makeFile(`console.log("Key:", process.env.SECRET_KEY)`, { relativePath: 'src/app.ts' })
    const findings = leakedEnvInLogsRule.check(file, project)
    expect(findings[0].fix).toContain('redacted')
  })
})
