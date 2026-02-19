import type { Rule, Finding, FileContext, ProjectContext } from '../types.js'
import { isCommentLine, isTestFile, isApiRoute } from '../utils/patterns.js'

const ERROR_LEAK_PATTERNS = [
  { pattern: /error\.stack/, msg: 'error.stack exposed — leaks internal file paths and code structure' },
  { pattern: /error\.message/, msg: 'error.message may leak internal details to clients' },
]

export const verboseErrorResponseRule: Rule = {
  id: 'verbose-error-response',
  name: 'Verbose Error Response',
  description: 'Detects error details (stack traces, error messages) sent directly in API responses',
  category: 'security',
  severity: 'warning',
  fileExtensions: ['ts', 'tsx', 'js', 'jsx'],

  check(file: FileContext, _project: ProjectContext): Finding[] {
    if (isTestFile(file.relativePath)) return []
    if (!isApiRoute(file.relativePath) && !/['"]use server['"]/.test(file.content)) return []

    const findings: Finding[] = []

    for (let i = 0; i < file.lines.length; i++) {
      if (isCommentLine(file.lines, i, file.commentMap)) continue
      const line = file.lines[i]

      for (const { pattern, msg } of ERROR_LEAK_PATTERNS) {
        const match = pattern.exec(line)
        if (match) {
          const severity = pattern.source.includes('stack') ? 'warning' : 'info'
          findings.push({
            ruleId: 'verbose-error-response',
            file: file.relativePath,
            line: i + 1,
            column: match.index + 1,
            message: msg,
            severity,
            category: 'security',
            fix: 'Return a generic error message: { error: "Internal server error" }. Log the real error server-side.',
          })
          break
        }
      }
    }

    return findings
  },
}
