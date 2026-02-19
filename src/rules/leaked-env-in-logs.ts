import type { Rule, Finding, FileContext, ProjectContext } from '../types.js'
import { isCommentLine, isTestFile, isScriptFile } from '../utils/patterns.js'

const CONSOLE_WITH_ENV = /console\.(log|warn|error|info|debug)\s*\([^)]*process\.env\./

export const leakedEnvInLogsRule: Rule = {
  id: 'leaked-env-in-logs',
  name: 'Leaked Env in Logs',
  description: 'Detects process.env values logged to console — potential secret exposure',
  category: 'security',
  severity: 'warning',
  fileExtensions: ['ts', 'tsx', 'js', 'jsx'],

  check(file: FileContext, _project: ProjectContext): Finding[] {
    if (isTestFile(file.relativePath)) return []
    if (isScriptFile(file.relativePath)) return []

    const findings: Finding[] = []

    for (let i = 0; i < file.lines.length; i++) {
      if (isCommentLine(file.lines, i, file.commentMap)) continue
      const line = file.lines[i]

      const match = CONSOLE_WITH_ENV.exec(line)
      if (match) {
        findings.push({
          ruleId: 'leaked-env-in-logs',
          file: file.relativePath,
          line: i + 1,
          column: match.index + 1,
          message: 'process.env value in console output — may leak secrets in production logs',
          severity: 'warning',
          category: 'security',
          fix: 'Remove process.env.* from console output — log a redacted summary instead',
        })
      }
    }

    return findings
  },
}
