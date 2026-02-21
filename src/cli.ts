import { parseArgs } from 'node:util'
import { scan } from './scanner.js'
import { reportPretty, reportJson, reportWebPretty } from './reporter.js'
import { getVersion } from './utils/version.js'
import type { Severity } from './types.js'

const SEVERITY_RANK: Record<Severity, number> = { critical: 3, warning: 2, info: 1 }

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      json: { type: 'boolean', default: false },
      ignore: { type: 'string', multiple: true, default: [] },
      'min-severity': { type: 'string', default: 'info' },
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

  // Web scanner mode
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
  const minSeverity = (values['min-severity'] as Severity) ?? 'info'

  const result = await scan({
    path: targetPath,
    ignore: values.ignore as string[],
  })

  // Filter findings by minimum severity
  const minRank = SEVERITY_RANK[minSeverity] ?? 1
  result.findings = result.findings.filter(f => SEVERITY_RANK[f.severity] >= minRank)

  if (values.json) {
    console.log(reportJson(result))
  } else {
    console.log(reportPretty(result, { quiet: values.quiet as boolean }))
  }

  if (result.summary.critical > 0) {
    process.exit(1)
  }
}

async function runWebScan(url: string, opts: { json: boolean }) {
  const res = await fetch('https://prodlint.com/api/scan-web', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url }),
  })

  if (!res.ok) {
    const data = await res.json().catch(() => ({ error: `HTTP ${res.status}` }))
    console.error(`Scan failed: ${(data as Record<string, string>).error || res.statusText}`)
    process.exit(2)
  }

  const data = await res.json()

  if (opts.json) {
    console.log(JSON.stringify(data, null, 2))
  } else {
    console.log(reportWebPretty(data as WebScanResult))
  }
}

interface WebScanResult {
  url: string
  domain: string
  overallScore: number
  grade: string
  checks: { id: string; name: string; status: string; severity: string; points: number; maxPoints: number; details?: string }[]
  summary: { passed: number; failed: number; warnings: number; totalChecks: number }
}

function printHelp() {
  console.log(`
  prodlint - The linter for vibe-coded apps

  Usage:
    npx prodlint [path] [options]
    npx prodlint --web <url>

  Options:
    --json                    Output results as JSON
    --ignore <pattern>        Glob patterns to ignore (can be repeated)
    --min-severity <level>    Minimum severity to show: critical, warning, info (default: info)
    --quiet                   Suppress badge and summary
    --web                     Get your site's prodlint score (14 AI agent checks)
    -h, --help                Show this help message
    -v, --version             Show version

  Examples:
    npx prodlint                              Scan current directory
    npx prodlint ./my-app                     Scan specific path
    npx prodlint --json                       JSON output
    npx prodlint --ignore "*.test"            Ignore test files
    npx prodlint --min-severity warning       Only warnings and criticals
    npx prodlint --quiet                      No badge output
    npx prodlint --web example.com            Site score
    npx prodlint --web example.com --json     Site score with JSON output
`)
}

main().catch((err) => {
  console.error('prodlint error:', err instanceof Error ? err.message : 'Unknown error')
  process.exit(2)
})
