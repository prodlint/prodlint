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
