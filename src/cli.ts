import { parseArgs } from 'node:util'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { scan } from './scanner.js'
import { reportPretty, reportJson, reportSummary, reportSarif, reportWebPretty } from './reporter.js'
import { getVersion } from './utils/version.js'
import { runWebScan as runWebScanLocal, normalizeUrl, isPrivateHost } from './web-scanner/index.js'
import type { WebScanResult } from './web-scanner/index.js'
import type { Severity, Finding } from './types.js'

const SEVERITY_RANK: Record<Severity, number> = { critical: 3, warning: 2, info: 1 }

const PROFILE_SEVERITY: Record<string, Severity> = {
  startup: 'critical',
  balanced: 'warning',
  strict: 'info',
}

interface BaselineEntry {
  ruleId: string
  file: string
  line: number
  message: string
}

function fingerprintFinding(f: Finding): string {
  return `${f.ruleId}::${f.file}::${f.line}`
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      json: { type: 'boolean', default: false },
      sarif: { type: 'boolean', default: false },
      summary: { type: 'boolean', default: false },
      ignore: { type: 'string', multiple: true, default: [] },
      'min-severity': { type: 'string', default: 'info' },
      profile: { type: 'string' },
      baseline: { type: 'string' },
      'baseline-save': { type: 'string' },
      quiet: { type: 'boolean', default: false },
      web: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
      version: { type: 'boolean', short: 'v', default: false },
    },
  })

  if (values.help) {
    printHelp()
    process.exit(0)
  }

  if (values.version) {
    console.log(getVersion())
    process.exit(0)
  }

  // Site score mode
  if (values.web) {
    const url = positionals[0]
    if (!url) {
      console.error('Usage: npx prodlint --web <url>')
      process.exit(2)
    }
    await runWebScan(url, { json: values.json as boolean })
    return
  }

  const targetPath = positionals[0] ?? '.'

  // Resolve min-severity: --profile overrides --min-severity
  let minSeverity: Severity
  if (values.profile) {
    const profileName = values.profile as string
    if (!(profileName in PROFILE_SEVERITY)) {
      console.error(`Unknown profile: ${profileName}. Available: startup, balanced, strict`)
      process.exit(2)
    }
    minSeverity = PROFILE_SEVERITY[profileName]
  } else {
    minSeverity = (values['min-severity'] as Severity) ?? 'info'
  }

  const result = await scan({
    path: targetPath,
    ignore: values.ignore as string[],
  })

  // Filter findings by minimum severity
  const minRank = SEVERITY_RANK[minSeverity] ?? 1
  result.findings = result.findings.filter(f => SEVERITY_RANK[f.severity] >= minRank)

  // Recompute summary after filtering
  result.summary = {
    critical: result.findings.filter(f => f.severity === 'critical').length,
    warning: result.findings.filter(f => f.severity === 'warning').length,
    info: result.findings.filter(f => f.severity === 'info').length,
  }

  // Baseline: save snapshot
  if (values['baseline-save']) {
    const baselinePath = values['baseline-save'] as string
    const entries: BaselineEntry[] = result.findings.map(f => ({
      ruleId: f.ruleId,
      file: f.file,
      line: f.line,
      message: f.message,
    }))
    writeFileSync(baselinePath, JSON.stringify(entries, null, 2))
    console.log(`Baseline saved: ${entries.length} findings written to ${baselinePath}`)
    return
  }

  // Baseline: filter to only new findings
  if (values.baseline) {
    const baselinePath = values.baseline as string
    if (!existsSync(baselinePath)) {
      console.error(`Baseline file not found: ${baselinePath}`)
      console.error('Run with --baseline-save first to create a baseline.')
      process.exit(2)
    }
    const baselineData: BaselineEntry[] = JSON.parse(readFileSync(baselinePath, 'utf8'))
    const baselineFingerprints = new Set(
      baselineData.map(e => `${e.ruleId}::${e.file}::${e.line}`)
    )
    result.findings = result.findings.filter(
      f => !baselineFingerprints.has(fingerprintFinding(f))
    )
    // Recompute summary after baseline filtering
    result.summary = {
      critical: result.findings.filter(f => f.severity === 'critical').length,
      warning: result.findings.filter(f => f.severity === 'warning').length,
      info: result.findings.filter(f => f.severity === 'info').length,
    }
  }

  // Output
  if (values.sarif) {
    console.log(reportSarif(result))
  } else if (values.json) {
    console.log(reportJson(result))
  } else if (values.summary) {
    console.log(reportSummary(result))
  } else {
    console.log(reportPretty(result, { quiet: values.quiet as boolean }))
  }

  if (result.summary.critical > 0) {
    process.exit(1)
  }
}

async function runWebScan(url: string, opts: { json: boolean }) {
  let normalizedUrl: string
  try {
    normalizedUrl = normalizeUrl(url)
  } catch {
    console.error('Invalid URL:', url)
    process.exit(2)
  }

  const hostname = new URL(normalizedUrl).hostname
  if (isPrivateHost(hostname)) {
    console.error('Cannot scan private/internal hosts.')
    process.exit(2)
  }

  const result = await runWebScanLocal(normalizedUrl)

  if (opts.json) {
    console.log(JSON.stringify(result, null, 2))
  } else {
    console.log(reportWebPretty(result as WebScanResult))
  }
}

function printHelp() {
  console.log(`
  prodlint - The linter for vibe-coded apps

  Usage:
    npx prodlint [path] [options]
    npx prodlint --web <url>

  Options:
    --json                    Output results as JSON
    --sarif                   Output results as SARIF 2.1.0 (for GitHub Code Scanning)
    --summary                 Quick pass/fail verdict with top 3 findings
    --ignore <pattern>        Glob patterns to ignore (can be repeated)
    --min-severity <level>    Minimum severity: critical, warning, info (default: info)
    --profile <name>          Preset: startup (criticals only), balanced (warnings+), strict (all)
    --baseline <file>         Only show findings not in baseline file
    --baseline-save <file>    Save current findings as baseline snapshot
    --quiet                   Suppress badge and summary
    --web                     Get your site's prodlint score (14 AI agent checks)
    -h, --help                Show this help message
    -v, --version             Show version

  Examples:
    npx prodlint                                  Scan current directory
    npx prodlint ./my-app                         Scan specific path
    npx prodlint --json                           JSON output
    npx prodlint --sarif                          SARIF output for CI integration
    npx prodlint --summary                        Quick pass/fail + top blockers
    npx prodlint --profile startup                Only critical findings
    npx prodlint --baseline .prodlint-baseline.json   Only new findings
    npx prodlint --baseline-save .prodlint-baseline.json   Save baseline
    npx prodlint --ignore "*.test"                Ignore test files
    npx prodlint --min-severity warning           Only warnings and criticals
    npx prodlint --quiet                          No badge output
    npx prodlint --web example.com                Site score
    npx prodlint --web example.com --json         Site score with JSON output
`)
}

main().catch((err) => {
  console.error('prodlint error:', err instanceof Error ? err.message : 'Unknown error')
  process.exit(2)
})
