import { walkFiles, readFileContext, buildProjectContext } from './utils/file-walker.js'
import { isLineSuppressed } from './utils/patterns.js'
import { calculateScores, summarizeFindings } from './scorer.js'
import { rules } from './rules/index.js'
import type { Finding, ScanOptions, ScanResult } from './types.js'
import { resolve } from 'node:path'
import { readFileSync } from 'node:fs'

function getVersion(): string {
  try {
    const pkg = JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf-8'),
    )
    return pkg.version ?? '0.0.0'
  } catch {
    return '0.0.0'
  }
}

export async function scan(options: ScanOptions): Promise<ScanResult> {
  const start = performance.now()
  const root = resolve(options.path)

  // Walk files
  const filePaths = await walkFiles(root, options.ignore)

  // Build project context
  const project = await buildProjectContext(root, filePaths)

  // Run rules against each file
  const findings: Finding[] = []

  for (const relativePath of filePaths) {
    const file = await readFileContext(root, relativePath)
    if (!file) continue

    for (const rule of rules) {
      // Skip if file extension doesn't match (empty = all files)
      if (
        rule.fileExtensions.length > 0 &&
        !rule.fileExtensions.includes(file.ext)
      ) {
        continue
      }

      const ruleFindings = rule.check(file, project)

      // Filter suppressed findings
      for (const finding of ruleFindings) {
        if (!isLineSuppressed(file.lines, finding.line - 1, finding.ruleId)) {
          findings.push(finding)
        }
      }
    }
  }

  const { overallScore, categoryScores } = calculateScores(findings)
  const summary = summarizeFindings(findings)

  return {
    version: getVersion(),
    scannedPath: root,
    filesScanned: filePaths.length,
    scanDurationMs: Math.round(performance.now() - start),
    findings,
    overallScore,
    categoryScores,
    summary,
  }
}
