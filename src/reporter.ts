import pc from 'picocolors'
import type { ScanResult, Finding } from './types.js'

const SEVERITY_COLORS = {
  critical: pc.red,
  warning: pc.yellow,
  info: pc.blue,
} as const

const SEVERITY_LABELS = {
  critical: 'CRIT',
  warning: 'WARN',
  info: 'INFO',
} as const

function scoreColor(score: number): (s: string) => string {
  if (score >= 80) return pc.green
  if (score >= 50) return pc.yellow
  return pc.red
}

function groupByFile(findings: Finding[]): Map<string, Finding[]> {
  const map = new Map<string, Finding[]>()
  for (const f of findings) {
    const group = map.get(f.file) ?? []
    group.push(f)
    map.set(f.file, group)
  }
  return map
}

export interface ReportOptions {
  quiet?: boolean
}

export function reportPretty(result: ScanResult, opts: ReportOptions = {}): string {
  const lines: string[] = []
  const { critical, warning, info } = result.summary

  lines.push('')
  lines.push(pc.bold('  prodlint') + pc.dim(` v${result.version}`))

  // Summary counts in header
  const headerParts: string[] = [`Scanned ${result.filesScanned} files`]
  if (critical > 0) headerParts.push(`${critical} critical`)
  if (warning > 0) headerParts.push(`${warning} warnings`)
  if (info > 0) headerParts.push(`${info} info`)
  lines.push(pc.dim(`  ${headerParts.join(' · ')}`))
  lines.push('')

  // Findings grouped by file
  if (result.findings.length > 0) {
    const grouped = groupByFile(result.findings)
    for (const [file, findings] of grouped) {
      lines.push(pc.underline(file))
      for (const f of findings) {
        const color = SEVERITY_COLORS[f.severity]
        const label = SEVERITY_LABELS[f.severity]
        lines.push(
          `  ${pc.dim(`${f.line}:${f.column}`)}  ${color(label)}  ${f.message}  ${pc.dim(f.ruleId)}`,
        )
        if (f.fix) {
          lines.push(`  ${pc.dim(`      ↳ ${f.fix}`)}`)
        }
      }
      lines.push('')
    }
  }

  // Category scores
  lines.push(pc.bold('  Scores'))
  for (const cs of result.categoryScores) {
    const color = scoreColor(cs.score)
    const bar = renderBar(cs.score)
    lines.push(`  ${cs.category.padEnd(14)} ${color(String(cs.score).padStart(3))} ${bar}  ${pc.dim(`(${cs.findingCount} issues)`)}`)
  }
  lines.push('')

  // Overall
  const overallColor = scoreColor(result.overallScore)
  lines.push(pc.bold(`  Overall: ${overallColor(String(result.overallScore))}/100`))
  lines.push('')

  // Summary line
  const summaryParts: string[] = []
  if (critical > 0) summaryParts.push(pc.red(`${critical} critical`))
  if (warning > 0) summaryParts.push(pc.yellow(`${warning} warnings`))
  if (info > 0) summaryParts.push(pc.blue(`${info} info`))
  if (summaryParts.length === 0) {
    lines.push(pc.green('  No issues found!'))
  } else {
    lines.push(`  ${summaryParts.join(pc.dim(' · '))}`)
  }
  lines.push('')

  // Badge (skip in quiet mode)
  if (!opts.quiet) {
    const badgeColor = result.overallScore >= 80 ? 'brightgreen' : result.overallScore >= 60 ? 'yellow' : 'red'
    const badgeUrl = `https://img.shields.io/badge/prodlint-${result.overallScore}%2F100-${badgeColor}`
    lines.push(pc.dim('  Add to your README:'))
    lines.push(pc.dim(`  [![prodlint](${badgeUrl})](https://prodlint.com)`))
    lines.push('')
  }

  return lines.join('\n')
}

export function reportJson(result: ScanResult): string {
  return JSON.stringify(result, null, 2)
}

function renderBar(score: number): string {
  const width = 20
  const filled = Math.round((score / 100) * width)
  const empty = width - filled
  const color = scoreColor(score)
  return color('█'.repeat(filled)) + pc.dim('░'.repeat(empty))
}

// Web scanner report
interface WebScanCheck {
  id: string
  name: string
  status: string
  severity: string
  points: number
  maxPoints: number
  details?: string
}

interface WebScanResult {
  url: string
  domain: string
  overallScore: number
  grade: string
  checks: WebScanCheck[]
  summary: { passed: number; failed: number; warnings: number; totalChecks: number }
}

const STATUS_ICONS: Record<string, (s: string) => string> = {
  pass: pc.green,
  fail: pc.red,
  warn: pc.yellow,
  info: pc.blue,
}

const STATUS_SYMBOLS: Record<string, string> = {
  pass: '✓',
  fail: '✗',
  warn: '!',
  info: 'i',
}

export function reportWebPretty(result: WebScanResult): string {
  const lines: string[] = []

  lines.push('')
  lines.push(pc.bold('  prodlint site score'))
  lines.push(pc.dim(`  ${result.domain} · ${result.summary.totalChecks} checks`))
  lines.push('')

  // Score
  const overallColor = scoreColor(result.overallScore)
  const bar = renderBar(result.overallScore)
  lines.push(`  ${pc.bold('Score:')} ${overallColor(pc.bold(`${result.overallScore}`))} ${overallColor(result.grade)}  ${bar}`)
  lines.push('')

  // Checks sorted: fail first, then warn, info, pass
  const order: Record<string, number> = { fail: 0, warn: 1, info: 2, pass: 3 }
  const sorted = [...result.checks].sort((a, b) => (order[a.status] ?? 9) - (order[b.status] ?? 9))

  for (const check of sorted) {
    const color = STATUS_ICONS[check.status] ?? pc.dim
    const symbol = STATUS_SYMBOLS[check.status] ?? '?'
    const pts = `${check.points}/${check.maxPoints}`
    lines.push(`  ${color(symbol)} ${check.name.padEnd(28)} ${pc.dim(pts.padStart(6))}  ${pc.dim(check.details || '')}`)
  }

  lines.push('')
  const parts: string[] = []
  if (result.summary.passed > 0) parts.push(pc.green(`${result.summary.passed} passed`))
  if (result.summary.failed > 0) parts.push(pc.red(`${result.summary.failed} failed`))
  if (result.summary.warnings > 0) parts.push(pc.yellow(`${result.summary.warnings} warnings`))
  lines.push(`  ${parts.join(pc.dim(' · '))}`)
  lines.push('')

  lines.push(pc.dim(`  Full results: https://prodlint.com/score?url=${encodeURIComponent(result.domain)}`))
  lines.push('')

  return lines.join('\n')
}
