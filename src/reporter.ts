import pc from 'picocolors'
import type { ScanResult, Finding, Rule } from './types.js'
import { rules } from './rules/index.js'
import { getVersion } from './utils/version.js'

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

export function reportSummary(result: ScanResult): string {
  const lines: string[] = []
  const { critical, warning, info } = result.summary
  const hasCritical = critical > 0

  const verdict = hasCritical ? pc.red(pc.bold('FAIL')) : pc.green(pc.bold('PASS'))
  const scorePart = scoreColor(result.overallScore)(`${result.overallScore}/100`)

  const countParts: string[] = []
  if (critical > 0) countParts.push(`${critical} critical`)
  if (warning > 0) countParts.push(`${warning} warning`)
  if (info > 0) countParts.push(`${info} info`)

  lines.push('')
  if (countParts.length > 0) {
    lines.push(`  ${verdict} ${pc.dim('—')} ${countParts.join(', ')} ${pc.dim(`(score: ${scorePart})`)}`)
  } else {
    lines.push(`  ${verdict} ${pc.dim('—')} no issues ${pc.dim(`(score: ${scorePart})`)}`)
  }

  // Show top 3 critical/warning findings
  const topFindings = result.findings
    .filter(f => f.severity === 'critical' || f.severity === 'warning')
    .slice(0, 3)

  if (topFindings.length > 0) {
    for (let i = 0; i < topFindings.length; i++) {
      const f = topFindings[i]
      const color = SEVERITY_COLORS[f.severity]
      const label = SEVERITY_LABELS[f.severity]
      lines.push(`  ${pc.dim(`${i + 1}.`)} ${f.file}:${f.line} ${pc.dim('—')} ${color(label)} ${f.message} ${pc.dim(f.ruleId)}`)
    }
  }

  lines.push('')
  return lines.join('\n')
}

const SARIF_SEVERITY_MAP: Record<string, string> = {
  critical: 'error',
  warning: 'warning',
  info: 'note',
}

export function reportSarif(result: ScanResult): string {
  const ruleMap = new Map<string, Rule>()
  for (const r of rules) {
    ruleMap.set(r.id, r)
  }

  // Collect unique rule IDs from findings
  const usedRuleIds = new Set(result.findings.map(f => f.ruleId))

  const sarifRules = [...usedRuleIds].map(id => {
    const rule = ruleMap.get(id)
    return {
      id,
      name: rule?.name ?? id,
      shortDescription: { text: rule?.description ?? id },
      defaultConfiguration: {
        level: SARIF_SEVERITY_MAP[rule?.severity ?? 'info'] ?? 'note',
      },
      helpUri: `https://prodlint.com/rules/${id}`,
    }
  })

  const sarifResults = result.findings.map(f => {
    const sarifResult: Record<string, unknown> = {
      ruleId: f.ruleId,
      level: SARIF_SEVERITY_MAP[f.severity] ?? 'note',
      message: { text: f.message },
      locations: [
        {
          physicalLocation: {
            artifactLocation: { uri: f.file.replace(/\\/g, '/') },
            region: { startLine: f.line, startColumn: f.column },
          },
        },
      ],
    }

    if (f.fix) {
      sarifResult.fixes = [
        {
          description: { text: f.fix },
        },
      ]
    }

    return sarifResult
  })

  const sarif = {
    $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
    version: '2.1.0' as const,
    runs: [
      {
        tool: {
          driver: {
            name: 'prodlint',
            version: getVersion(),
            informationUri: 'https://prodlint.com',
            rules: sarifRules,
          },
        },
        results: sarifResults,
      },
    ],
  }

  return JSON.stringify(sarif, null, 2)
}

function renderBar(score: number): string {
  const width = 20
  const filled = Math.round((score / 100) * width)
  const empty = width - filled
  const color = scoreColor(score)
  return color('█'.repeat(filled)) + pc.dim('░'.repeat(empty))
}

// Site score report
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
