import type { Category, CategoryScore, Finding } from './types.js'

const CATEGORIES: Category[] = ['security', 'reliability', 'performance', 'ai-quality']

const CATEGORY_WEIGHTS: Record<Category, number> = {
  'security': 0.40,
  'reliability': 0.30,
  'performance': 0.15,
  'ai-quality': 0.15,
}

const DEDUCTIONS: Record<string, number> = {
  critical: 8,
  warning: 2,
  info: 0.5,
}

/** Max findings counted per rule per severity */
const PER_RULE_CAP: Record<string, number> = {
  critical: 1,
  warning: 2,
  info: 3,
}

export function calculateScores(findings: Finding[]): {
  overallScore: number
  categoryScores: CategoryScore[]
} {
  const categoryScores: CategoryScore[] = CATEGORIES.map(category => {
    const categoryFindings = findings.filter(f => f.category === category)

    // Group findings by ruleId, then apply per-rule caps
    const byRule = new Map<string, Finding[]>()
    for (const f of categoryFindings) {
      const arr = byRule.get(f.ruleId) ?? []
      arr.push(f)
      byRule.set(f.ruleId, arr)
    }

    let totalDeduction = 0

    for (const [, ruleFindings] of byRule) {
      // Group by severity within this rule
      const bySeverity = { critical: 0, warning: 0, info: 0 }
      for (const f of ruleFindings) {
        bySeverity[f.severity]++
      }

      // Apply per-rule cap for each severity
      for (const sev of ['critical', 'warning', 'info'] as const) {
        const count = Math.min(bySeverity[sev], PER_RULE_CAP[sev])
        totalDeduction += count * DEDUCTIONS[sev]
      }
    }

    // Diminishing returns: after 30 points deducted, halve; after 50, quarter
    let effectiveDeduction: number
    if (totalDeduction <= 30) {
      effectiveDeduction = totalDeduction
    } else if (totalDeduction <= 50) {
      effectiveDeduction = 30 + (totalDeduction - 30) * 0.5
    } else {
      effectiveDeduction = 30 + (50 - 30) * 0.5 + (totalDeduction - 50) * 0.25
    }

    return {
      category,
      score: Math.max(0, Math.round(100 - effectiveDeduction)),
      findingCount: categoryFindings.length,
    }
  })

  const overallScore = Math.round(
    categoryScores.reduce((sum, c) => sum + c.score * CATEGORY_WEIGHTS[c.category], 0),
  )

  return { overallScore, categoryScores }
}

export function summarizeFindings(findings: Finding[]) {
  return {
    critical: findings.filter(f => f.severity === 'critical').length,
    warning: findings.filter(f => f.severity === 'warning').length,
    info: findings.filter(f => f.severity === 'info').length,
  }
}
