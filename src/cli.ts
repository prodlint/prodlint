import { parseArgs } from 'node:util'
import { scan } from './scanner.js'
import { reportPretty, reportJson } from './reporter.js'
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

function printHelp() {
  console.log(`
  prodlint - Scan AI-generated projects for production readiness issues

  Usage:
    npx prodlint [path] [options]

  Options:
    --json                    Output results as JSON
    --ignore <pattern>        Glob patterns to ignore (can be repeated)
    --min-severity <level>    Minimum severity to show: critical, warning, info (default: info)
    --quiet                   Suppress badge and summary
    -h, --help                Show this help message
    -v, --version             Show version

  Examples:
    npx prodlint                              Scan current directory
    npx prodlint ./my-app                     Scan specific path
    npx prodlint --json                       JSON output
    npx prodlint --ignore "*.test"            Ignore test files
    npx prodlint --min-severity warning       Only warnings and criticals
    npx prodlint --quiet                      No badge output
`)
}

main().catch((err) => {
  console.error('prodlint error:', err instanceof Error ? err.message : 'Unknown error')
  process.exit(2)
})
