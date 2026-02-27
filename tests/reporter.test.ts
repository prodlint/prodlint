import { describe, it, expect } from 'vitest'
import { reportSummary, reportSarif, reportJson } from '../src/reporter.js'
import type { ScanResult, Finding } from '../src/types.js'

function makeFinding(overrides: Partial<Finding> = {}): Finding {
  return {
    ruleId: 'test-rule',
    file: 'src/test.ts',
    line: 10,
    column: 1,
    message: 'Test finding',
    severity: 'warning',
    category: 'security',
    ...overrides,
  }
}

function makeResult(overrides: Partial<ScanResult> = {}): ScanResult {
  return {
    version: '0.9.1',
    scannedPath: '.',
    filesScanned: 5,
    scanDurationMs: 42,
    findings: [],
    overallScore: 100,
    categoryScores: [
      { category: 'security', score: 100, findingCount: 0 },
      { category: 'reliability', score: 100, findingCount: 0 },
      { category: 'performance', score: 100, findingCount: 0 },
      { category: 'ai-quality', score: 100, findingCount: 0 },
    ],
    summary: { critical: 0, warning: 0, info: 0 },
    ...overrides,
  }
}

describe('reportSummary', () => {
  it('outputs PASS when no findings', () => {
    const output = reportSummary(makeResult())
    expect(output).toContain('PASS')
    expect(output).toContain('no issues')
    expect(output).toContain('100/100')
  })

  it('outputs FAIL when critical findings exist', () => {
    const result = makeResult({
      findings: [
        makeFinding({ severity: 'critical', ruleId: 'secrets', message: 'Hardcoded secret' }),
      ],
      overallScore: 42,
      summary: { critical: 1, warning: 0, info: 0 },
    })
    const output = reportSummary(result)
    expect(output).toContain('FAIL')
    expect(output).toContain('1 critical')
    expect(output).toContain('42/100')
    expect(output).toContain('Hardcoded secret')
  })

  it('shows top 3 findings only', () => {
    const findings = [
      makeFinding({ severity: 'critical', ruleId: 'r1', message: 'First' }),
      makeFinding({ severity: 'critical', ruleId: 'r2', message: 'Second' }),
      makeFinding({ severity: 'critical', ruleId: 'r3', message: 'Third' }),
      makeFinding({ severity: 'critical', ruleId: 'r4', message: 'Fourth should be hidden' }),
    ]
    const result = makeResult({
      findings,
      summary: { critical: 4, warning: 0, info: 0 },
    })
    const output = reportSummary(result)
    expect(output).toContain('First')
    expect(output).toContain('Second')
    expect(output).toContain('Third')
    expect(output).not.toContain('Fourth should be hidden')
  })

  it('includes warnings and criticals, skips info', () => {
    const findings = [
      makeFinding({ severity: 'critical', message: 'Critical one' }),
      makeFinding({ severity: 'warning', message: 'Warning one' }),
      makeFinding({ severity: 'info', message: 'Info should not show' }),
    ]
    const result = makeResult({
      findings,
      summary: { critical: 1, warning: 1, info: 1 },
    })
    const output = reportSummary(result)
    expect(output).toContain('Critical one')
    expect(output).toContain('Warning one')
    expect(output).not.toContain('Info should not show')
  })
})

describe('reportSarif', () => {
  it('produces valid SARIF 2.1.0 structure', () => {
    const result = makeResult()
    const output = reportSarif(result)
    const sarif = JSON.parse(output)

    expect(sarif.$schema).toBe('https://json.schemastore.org/sarif-2.1.0.json')
    expect(sarif.version).toBe('2.1.0')
    expect(sarif.runs).toHaveLength(1)
    expect(sarif.runs[0].tool.driver.name).toBe('prodlint')
    expect(sarif.runs[0].results).toEqual([])
  })

  it('maps findings to SARIF results', () => {
    const findings = [
      makeFinding({
        ruleId: 'secrets',
        file: 'src/config.ts',
        line: 5,
        column: 3,
        message: 'Hardcoded API key',
        severity: 'critical',
        fix: 'Move to environment variable',
      }),
    ]
    const result = makeResult({ findings, summary: { critical: 1, warning: 0, info: 0 } })
    const sarif = JSON.parse(reportSarif(result))

    const sarifResult = sarif.runs[0].results[0]
    expect(sarifResult.ruleId).toBe('secrets')
    expect(sarifResult.level).toBe('error')
    expect(sarifResult.message.text).toBe('Hardcoded API key')
    expect(sarifResult.locations[0].physicalLocation.artifactLocation.uri).toBe('src/config.ts')
    expect(sarifResult.locations[0].physicalLocation.region.startLine).toBe(5)
    expect(sarifResult.locations[0].physicalLocation.region.startColumn).toBe(3)
    expect(sarifResult.fixes[0].description.text).toBe('Move to environment variable')
  })

  it('maps severity levels correctly', () => {
    const findings = [
      makeFinding({ severity: 'critical', ruleId: 'a' }),
      makeFinding({ severity: 'warning', ruleId: 'b' }),
      makeFinding({ severity: 'info', ruleId: 'c' }),
    ]
    const result = makeResult({ findings })
    const sarif = JSON.parse(reportSarif(result))

    expect(sarif.runs[0].results[0].level).toBe('error')
    expect(sarif.runs[0].results[1].level).toBe('warning')
    expect(sarif.runs[0].results[2].level).toBe('note')
  })

  it('includes rule definitions for used rules', () => {
    const findings = [
      makeFinding({ ruleId: 'secrets' }),
      makeFinding({ ruleId: 'auth-checks' }),
    ]
    const result = makeResult({ findings })
    const sarif = JSON.parse(reportSarif(result))

    const ruleIds = sarif.runs[0].tool.driver.rules.map((r: { id: string }) => r.id)
    expect(ruleIds).toContain('secrets')
    expect(ruleIds).toContain('auth-checks')
    expect(sarif.runs[0].tool.driver.rules[0].helpUri).toContain('prodlint.com/rules/')
  })

  it('omits fixes field when finding has no fix', () => {
    const findings = [makeFinding({ fix: undefined })]
    const result = makeResult({ findings })
    const sarif = JSON.parse(reportSarif(result))

    expect(sarif.runs[0].results[0].fixes).toBeUndefined()
  })

  it('normalizes backslashes in file paths', () => {
    const findings = [makeFinding({ file: 'src\\lib\\config.ts' })]
    const result = makeResult({ findings })
    const sarif = JSON.parse(reportSarif(result))

    expect(sarif.runs[0].results[0].locations[0].physicalLocation.artifactLocation.uri)
      .toBe('src/lib/config.ts')
  })
})
