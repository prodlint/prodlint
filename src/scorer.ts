import type { Category, CategoryScore, Finding } from './types.js'

const CATEGORIES: Category[] = ['security', 'reliability', 'performance', 'ai-quality']

const DEDUCTIONS: Record<string, number> = {
  critical: 10,
  warning: 3,
  info: 1,
}

export function calculateScores(findings: Finding[]): {
  overallScore: number
  categoryScores: CategoryScore[]
} {
  const categoryScores: CategoryScore[] = CATEGORIES.map(category => {
    const categoryFindings = findings.filter(f => f.category === category)
    let score = 100
    for (const f of categoryFindings) {
      score -= DEDUCTIONS[f.severity] ?? 0
    }
    return {
      category,
      score: Math.max(0, score),
      findingCount: categoryFindings.length,
    }
  })

  const overallScore = Math.round(
    categoryScores.reduce((sum, c) => sum + c.score, 0) / CATEGORIES.length,
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
