import { describe, it, expect } from 'vitest'
import { calculateScores, summarizeFindings } from '../src/scorer.js'
import type { Finding } from '../src/types.js'

function makeFinding(overrides: Partial<Finding> = {}): Finding {
  return {
    ruleId: 'test',
    file: 'test.ts',
    line: 1,
    column: 1,
    message: 'test finding',
    severity: 'warning',
    category: 'security',
    ...overrides,
  }
}

describe('calculateScores', () => {
  it('returns 100 for all categories with no findings', () => {
    const { overallScore, categoryScores } = calculateScores([])
    expect(overallScore).toBe(100)
    for (const cs of categoryScores) {
      expect(cs.score).toBe(100)
      expect(cs.findingCount).toBe(0)
    }
  })

  it('deducts 10 per critical', () => {
    const findings = [
      makeFinding({ severity: 'critical', category: 'security' }),
      makeFinding({ severity: 'critical', category: 'security' }),
    ]
    const { categoryScores } = calculateScores(findings)
    const security = categoryScores.find(c => c.category === 'security')!
    expect(security.score).toBe(80)
  })

  it('deducts 3 per warning', () => {
    const findings = [
      makeFinding({ severity: 'warning', category: 'reliability' }),
    ]
    const { categoryScores } = calculateScores(findings)
    const reliability = categoryScores.find(c => c.category === 'reliability')!
    expect(reliability.score).toBe(97)
  })

  it('deducts 1 per info', () => {
    const findings = [
      makeFinding({ severity: 'info', category: 'ai-quality' }),
    ]
    const { categoryScores } = calculateScores(findings)
    const aiQuality = categoryScores.find(c => c.category === 'ai-quality')!
    expect(aiQuality.score).toBe(99)
  })

  it('floors score at 0', () => {
    const findings = Array.from({ length: 15 }, () =>
      makeFinding({ severity: 'critical', category: 'security' }),
    )
    const { categoryScores } = calculateScores(findings)
    const security = categoryScores.find(c => c.category === 'security')!
    expect(security.score).toBe(0)
  })

  it('overall is average of 4 categories', () => {
    const findings = [
      makeFinding({ severity: 'critical', category: 'security' }),
    ]
    const { overallScore, categoryScores } = calculateScores(findings)
    const sum = categoryScores.reduce((s, c) => s + c.score, 0)
    expect(overallScore).toBe(Math.round(sum / 4))
  })

  it('includes all 4 categories', () => {
    const { categoryScores } = calculateScores([])
    const categories = categoryScores.map(c => c.category)
    expect(categories).toContain('security')
    expect(categories).toContain('reliability')
    expect(categories).toContain('performance')
    expect(categories).toContain('ai-quality')
  })
})

describe('summarizeFindings', () => {
  it('counts findings by severity', () => {
    const findings = [
      makeFinding({ severity: 'critical' }),
      makeFinding({ severity: 'critical' }),
      makeFinding({ severity: 'warning' }),
      makeFinding({ severity: 'info' }),
    ]
    const summary = summarizeFindings(findings)
    expect(summary.critical).toBe(2)
    expect(summary.warning).toBe(1)
    expect(summary.info).toBe(1)
  })

  it('returns zeros for empty findings', () => {
    const summary = summarizeFindings([])
    expect(summary.critical).toBe(0)
    expect(summary.warning).toBe(0)
    expect(summary.info).toBe(0)
  })
})
