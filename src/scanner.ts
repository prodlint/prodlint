import { walkFiles, readFileContext, buildProjectContext } from './utils/file-walker.js'
import { isLineSuppressed } from './utils/patterns.js'
import { getVersion } from './utils/version.js'
import { calculateScores, summarizeFindings } from './scorer.js'
import { rules } from './rules/index.js'
import type { Finding, FileContext, ScanOptions, ScanResult } from './types.js'
import { resolve } from 'node:path'

export async function scan(options: ScanOptions): Promise<ScanResult> {
  const start = performance.now()
  const root = resolve(options.path)

  const filePaths = await walkFiles(root, options.ignore)
  const project = await buildProjectContext(root, filePaths)

  const findings: Finding[] = []
  const allFiles: FileContext[] = []

  // Phase 1: Per-file rules
  for (const relativePath of filePaths) {
    const file = await readFileContext(root, relativePath)
    if (!file) continue

    allFiles.push(file)

    for (const rule of rules) {
      if (
        rule.fileExtensions.length > 0 &&
        !rule.fileExtensions.includes(file.ext)
      ) {
        continue
      }

      const ruleFindings = rule.check(file, project)

      for (const finding of ruleFindings) {
        if (!isLineSuppressed(file.lines, finding.line - 1, finding.ruleId)) {
          findings.push(finding)
        }
      }
    }
  }

  // Phase 2: Project-level rules (cross-file analysis)
  for (const rule of rules) {
    if (rule.checkProject) {
      const projectFindings = rule.checkProject(allFiles, project)
      findings.push(...projectFindings)
    }
  }

  const { overallScore, categoryScores } = calculateScores(findings)
  const summary = summarizeFindings(findings)

  return {
    version: getVersion(),
    scannedPath: options.path,
    filesScanned: filePaths.length,
    scanDurationMs: Math.round(performance.now() - start),
    findings,
    overallScore,
    categoryScores,
    summary,
  }
}
