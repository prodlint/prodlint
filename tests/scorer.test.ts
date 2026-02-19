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

  it('deducts 8 per unique critical rule', () => {
    const findings = [
      makeFinding({ ruleId: 'rule-a', severity: 'critical', category: 'security' }),
      makeFinding({ ruleId: 'rule-b', severity: 'critical', category: 'security' }),
    ]
    const { categoryScores } = calculateScores(findings)
    const security = categoryScores.find(c => c.category === 'security')!
    expect(security.score).toBe(84) // 100 - 8 - 8
  })

  it('caps duplicate critical findings from same rule to 1', () => {
    const findings = [
      makeFinding({ ruleId: 'same-rule', severity: 'critical', category: 'security' }),
      makeFinding({ ruleId: 'same-rule', severity: 'critical', category: 'security' }),
      makeFinding({ ruleId: 'same-rule', severity: 'critical', category: 'security' }),
    ]
    const { categoryScores } = calculateScores(findings)
    const security = categoryScores.find(c => c.category === 'security')!
    // Only 1 critical counted (capped), so -8
    expect(security.score).toBe(92)
    expect(security.findingCount).toBe(3) // still reports all findings
  })

  it('caps duplicate warning findings from same rule to 2', () => {
    const findings = Array.from({ length: 5 }, () =>
      makeFinding({ ruleId: 'warn-rule', severity: 'warning', category: 'reliability' }),
    )
    const { categoryScores } = calculateScores(findings)
    const reliability = categoryScores.find(c => c.category === 'reliability')!
    // Only 2 warnings counted (capped), so -2 * 2 = -4
    expect(reliability.score).toBe(96)
  })

  it('caps duplicate info findings from same rule to 3', () => {
    const findings = Array.from({ length: 10 }, () =>
      makeFinding({ ruleId: 'info-rule', severity: 'info', category: 'ai-quality' }),
    )
    const { categoryScores } = calculateScores(findings)
    const aiQuality = categoryScores.find(c => c.category === 'ai-quality')!
    // Only 3 info counted (capped), so -0.5 * 3 = -1.5 → 98.5 rounds to 99
    expect(aiQuality.score).toBe(99)
  })

  it('applies diminishing returns after 30 points', () => {
    // 5 unique critical rules = 5 * 8 = 40 raw deduction
    // Diminishing: 30 + (40-30)*0.5 = 35
    // Score: 100 - 35 = 65
    const findings = ['a', 'b', 'c', 'd', 'e'].map(id =>
      makeFinding({ ruleId: id, severity: 'critical', category: 'security' }),
    )
    const { categoryScores } = calculateScores(findings)
    const security = categoryScores.find(c => c.category === 'security')!
    expect(security.score).toBe(65)
  })

  it('applies diminishing returns after 50 points', () => {
    // 8 unique critical rules = 8 * 8 = 64 raw deduction
    // Diminishing: 30 + (50-30)*0.5 + (64-50)*0.25 = 30 + 10 + 3.5 = 43.5
    // Score: 100 - 43.5 = 56.5 → 57
    const findings = Array.from({ length: 8 }, (_, i) =>
      makeFinding({ ruleId: `rule-${i}`, severity: 'critical', category: 'security' }),
    )
    const { categoryScores } = calculateScores(findings)
    const security = categoryScores.find(c => c.category === 'security')!
    expect(security.score).toBe(57)
  })

  it('floors score at 0', () => {
    // Many unique critical rules
    const findings = Array.from({ length: 50 }, (_, i) =>
      makeFinding({ ruleId: `rule-${i}`, severity: 'critical', category: 'security' }),
    )
    const { categoryScores } = calculateScores(findings)
    const security = categoryScores.find(c => c.category === 'security')!
    expect(security.score).toBeGreaterThanOrEqual(0)
  })

  it('overall is weighted average (security 40%, reliability 30%, perf 15%, ai 15%)', () => {
    const findings = [
      makeFinding({ ruleId: 'r1', severity: 'critical', category: 'security' }),
    ]
    const { overallScore, categoryScores } = calculateScores(findings)
    const weights: Record<string, number> = { security: 0.4, reliability: 0.3, performance: 0.15, 'ai-quality': 0.15 }
    const expected = Math.round(categoryScores.reduce((s, c) => s + c.score * weights[c.category], 0))
    expect(overallScore).toBe(expected)
  })

  it('1 critical in security weighs more than in ai-quality', () => {
    const secFindings = [makeFinding({ ruleId: 'r1', severity: 'critical', category: 'security' })]
    const aiFindings = [makeFinding({ ruleId: 'r1', severity: 'critical', category: 'ai-quality' })]
    const { overallScore: secScore } = calculateScores(secFindings)
    const { overallScore: aiScore } = calculateScores(aiFindings)
    // Security has higher weight, so a hit there hurts overall more
    expect(secScore).toBeLessThan(aiScore)
  })

  it('includes all 4 categories', () => {
    const { categoryScores } = calculateScores([])
    const categories = categoryScores.map(c => c.category)
    expect(categories).toContain('security')
    expect(categories).toContain('reliability')
    expect(categories).toContain('performance')
    expect(categories).toContain('ai-quality')
  })

  it('deducts 2 per warning', () => {
    const findings = [
      makeFinding({ ruleId: 'w1', severity: 'warning', category: 'reliability' }),
    ]
    const { categoryScores } = calculateScores(findings)
    const reliability = categoryScores.find(c => c.category === 'reliability')!
    expect(reliability.score).toBe(98) // 100 - 2
  })

  it('deducts 0.5 per info', () => {
    const findings = [
      makeFinding({ ruleId: 'i1', severity: 'info', category: 'ai-quality' }),
    ]
    const { categoryScores } = calculateScores(findings)
    const aiQuality = categoryScores.find(c => c.category === 'ai-quality')!
    expect(aiQuality.score).toBe(100) // 100 - 0.5 = 99.5, rounds to 100
  })

  it('boundary: exactly 30 deduction stays linear', () => {
    // 30 / 8 = 3.75 unique critical rules → need to combine severities
    // 3 critical rules (24) + 3 unique warning rules (6) = 30 exactly
    const findings = [
      ...['c1', 'c2', 'c3'].map(id =>
        makeFinding({ ruleId: id, severity: 'critical', category: 'security' }),
      ),
      ...['w1', 'w2', 'w3'].map(id =>
        makeFinding({ ruleId: id, severity: 'warning', category: 'security' }),
      ),
    ]
    const { categoryScores } = calculateScores(findings)
    const security = categoryScores.find(c => c.category === 'security')!
    // 3*8 + 3*2 = 30. At boundary, no diminishing. 100 - 30 = 70
    expect(security.score).toBe(70)
  })

  it('boundary: exactly 50 raw deduction applies halving on 30-50 range', () => {
    // 6 critical rules (48) + 1 warning rule (2) = 50 exactly
    const findings = [
      ...Array.from({ length: 6 }, (_, i) =>
        makeFinding({ ruleId: `c${i}`, severity: 'critical', category: 'security' }),
      ),
      makeFinding({ ruleId: 'w1', severity: 'warning', category: 'security' }),
    ]
    const { categoryScores } = calculateScores(findings)
    const security = categoryScores.find(c => c.category === 'security')!
    // Raw = 50. Effective = 30 + (50-30)*0.5 = 40. Score = 100 - 40 = 60
    expect(security.score).toBe(60)
  })

  it('mixed severity on same rule applies per-severity caps', () => {
    // Same ruleId but different severities
    const findings = [
      // 3 criticals from same rule → capped to 1 → 8
      ...Array.from({ length: 3 }, () =>
        makeFinding({ ruleId: 'mixed', severity: 'critical', category: 'security' }),
      ),
      // 5 warnings from same rule → capped to 2 → 4
      ...Array.from({ length: 5 }, () =>
        makeFinding({ ruleId: 'mixed', severity: 'warning', category: 'security' }),
      ),
      // 10 infos from same rule → capped to 3 → 1.5
      ...Array.from({ length: 10 }, () =>
        makeFinding({ ruleId: 'mixed', severity: 'info', category: 'security' }),
      ),
    ]
    const { categoryScores } = calculateScores(findings)
    const security = categoryScores.find(c => c.category === 'security')!
    // 8 + 4 + 1.5 = 13.5. 100 - 13.5 = 86.5 → 87
    expect(security.score).toBe(87)
    expect(security.findingCount).toBe(18)
  })

  it('multiple rules each hitting their caps', () => {
    const findings = [
      // Rule A: 5 criticals → cap 1 → 8
      ...Array.from({ length: 5 }, () =>
        makeFinding({ ruleId: 'a', severity: 'critical', category: 'reliability' }),
      ),
      // Rule B: 5 criticals → cap 1 → 8
      ...Array.from({ length: 5 }, () =>
        makeFinding({ ruleId: 'b', severity: 'critical', category: 'reliability' }),
      ),
      // Rule C: 5 warnings → cap 2 → 4
      ...Array.from({ length: 5 }, () =>
        makeFinding({ ruleId: 'c', severity: 'warning', category: 'reliability' }),
      ),
    ]
    const { categoryScores } = calculateScores(findings)
    const reliability = categoryScores.find(c => c.category === 'reliability')!
    // 8 + 8 + 4 = 20 (under 30, no diminishing). 100 - 20 = 80
    expect(reliability.score).toBe(80)
    expect(reliability.findingCount).toBe(15)
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
