import { describe, it, expect } from 'vitest'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

interface Inputs {
  exitCode: number
  threshold: number
  failOnCritical: boolean
}

const require = createRequire(import.meta.url)
const SCRIPT = join(__dirname, '..', 'scripts', 'action-check.cjs')
const { failures, readInputs } = require(SCRIPT) as {
  failures: (result: unknown, inputs: Inputs) => string[]
  readInputs: (env: Record<string, string | undefined>) => Inputs
}
const ACTION = readFileSync(join(__dirname, '..', 'action.yml'), 'utf8').replace(/\r\n/g, '\n')

function result(score: number, critical: number) {
  return { overallScore: score, summary: { critical, warning: 0, info: 0 } }
}

describe('action check', () => {
  it('fails on critical findings with the default inputs', () => {
    const inputs = readInputs({ SCAN_EXIT_CODE: '1' })
    expect(inputs).toEqual({ exitCode: 1, threshold: 0, failOnCritical: true })
    expect(failures(result(88, 2), inputs)).toEqual([expect.stringContaining('2 critical issues')])
  })

  it('passes a scan without criticals', () => {
    const inputs = readInputs({ SCAN_EXIT_CODE: '0', INPUT_THRESHOLD: '0', INPUT_FAIL_ON_CRITICAL: 'true' })
    expect(failures(result(100, 0), inputs)).toEqual([])
  })

  it('reports criticals without failing when fail-on-critical is false', () => {
    const inputs = readInputs({ SCAN_EXIT_CODE: '1', INPUT_FAIL_ON_CRITICAL: 'false' })
    expect(failures(result(88, 2), inputs)).toEqual([])
  })

  it('fails when the score is below the threshold', () => {
    const inputs = readInputs({ SCAN_EXIT_CODE: '0', INPUT_THRESHOLD: '90', INPUT_FAIL_ON_CRITICAL: 'false' })
    expect(failures(result(85, 0), inputs)).toEqual(['Prodlint score (85) is below threshold (90)'])
  })

  // It used to read as a score of 0 with no criticals, which passed by default
  it('fails when prodlint did not produce a result', () => {
    expect(failures(null, readInputs({ SCAN_EXIT_CODE: '2' }))).toEqual([expect.stringContaining('exit code 2')])
    // npx exits 1 when it can't install the package; with no result, that isn't "criticals found"
    expect(failures(null, readInputs({ SCAN_EXIT_CODE: '1' }))).toEqual([expect.stringContaining('exit code 1')])
  })

  it('is wired into action.yml, with fail-on-critical on by default', () => {
    expect(ACTION).toMatch(/^ {2}fail-on-critical:\n(?: {4}.*\n)*? {4}default: 'true'$/m)
    expect(ACTION).not.toMatch(/\|\|\s*true/)
    expect(ACTION).toContain('scripts/action-check.cjs" check')
  })
})
