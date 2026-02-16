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

export function reportPretty(result: ScanResult): string {
  const lines: string[] = []

  lines.push('')
  lines.push(pc.bold('  prodlint') + pc.dim(` v${result.version}`))
  lines.push(pc.dim(`  Scanned ${result.filesScanned} files in ${result.scanDurationMs}ms`))
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
  const { critical, warning, info } = result.summary
  const parts: string[] = []
  if (critical > 0) parts.push(pc.red(`${critical} critical`))
  if (warning > 0) parts.push(pc.yellow(`${warning} warnings`))
  if (info > 0) parts.push(pc.blue(`${info} info`))
  if (parts.length === 0) {
    lines.push(pc.green('  No issues found!'))
  } else {
    lines.push(`  ${parts.join(pc.dim(' · '))}`)
  }
  lines.push('')

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
