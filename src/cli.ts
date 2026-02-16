import { parseArgs } from 'node:util'
import { scan } from './scanner.js'
import { reportPretty, reportJson } from './reporter.js'
import { getVersion } from './utils/version.js'

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      json: { type: 'boolean', default: false },
      ignore: { type: 'string', multiple: true, default: [] },
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

  const result = await scan({
    path: targetPath,
    ignore: values.ignore as string[],
  })

  if (values.json) {
    console.log(reportJson(result))
  } else {
    console.log(reportPretty(result))
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
    --json             Output results as JSON
    --ignore <pattern> Glob patterns to ignore (can be repeated)
    -h, --help         Show this help message
    -v, --version      Show version

  Examples:
    npx prodlint                    Scan current directory
    npx prodlint ./my-app           Scan specific path
    npx prodlint --json             JSON output
    npx prodlint --ignore "*.test"  Ignore test files
`)
}

main().catch((err) => {
  console.error(err)
  process.exit(2)
})
