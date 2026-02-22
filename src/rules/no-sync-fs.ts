import type { Rule, Finding, FileContext, ProjectContext } from '../types.js'
import { isCommentLine, isTestFile, isConfigFile, isApiRoute } from '../utils/patterns.js'

const SYNC_FS_PATTERN = /(?:readFileSync|writeFileSync|existsSync|mkdirSync|readdirSync|statSync|unlinkSync|copyFileSync|renameSync|appendFileSync|accessSync)\s*\(/

export const noSyncFsRule: Rule = {
  id: 'no-sync-fs',
  name: 'No Synchronous FS',
  description: 'Detects synchronous fs operations in API routes and server code',
  category: 'performance',
  severity: 'warning',
  fileExtensions: ['ts', 'tsx', 'js', 'jsx'],

  check(file: FileContext, _project: ProjectContext): Finding[] {
    // Skip test files, config files, and scripts
    if (isTestFile(file.relativePath)) return []
    if (isConfigFile(file.relativePath)) return []
    if (/(?:^|\/)scripts?\//.test(file.relativePath)) return []

    const findings: Finding[] = []

    for (let i = 0; i < file.lines.length; i++) {
      if (isCommentLine(file.lines, i, file.commentMap)) continue
      const line = file.lines[i]

      const match = SYNC_FS_PATTERN.exec(line)
      if (match) {
        const fnName = match[0].replace(/\s*\($/, '')
        // Higher severity for API routes
        const severity = isApiRoute(file.relativePath) ? 'warning' as const : 'info' as const
        findings.push({
          ruleId: 'no-sync-fs',
          file: file.relativePath,
          line: i + 1,
          column: match.index + 1,
          message: `Synchronous ${fnName}() blocks the event loop — use async alternative`,
          severity,
          category: 'performance',
          fix: `Use the async version: fs.promises.${fnName.replace('Sync', '')}() instead of ${fnName}()`,
        })
      }
    }

    return findings
  },
}
