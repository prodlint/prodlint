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

  // AST improvement: string literal mentioning process.env is safe
  it('AST: skips console.log("process.env.FOO is set") — string literal', () => {
    const file = makeFile(`console.log("process.env.FOO is set")`, { relativePath: 'src/app.ts' })
    const findings = leakedEnvInLogsRule.check(file, project)
    expect(findings).toHaveLength(0)
  })

  // AST improvement: multi-line console.log with process.env
  it('AST: flags multi-line console.log with process.env', () => {
    const file = makeFile([
      'console.log(',
      '  "Database:",',
      '  process.env.DATABASE_URL',
      ')',
    ].join('\n'), { relativePath: 'src/db.ts' })
    const findings = leakedEnvInLogsRule.check(file, project)
    expect(findings).toHaveLength(1)
  })

  // AST: regex fallback still works
  it('falls back to regex when AST is unavailable', () => {
    const file = makeFile(`console.log("Key:", process.env.API_KEY)`, { relativePath: 'src/app.ts', withAst: false })
    const findings = leakedEnvInLogsRule.check(file, project)
    expect(findings).toHaveLength(1)
  })
})
