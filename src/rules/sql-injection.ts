import type { Rule, Finding, FileContext, ProjectContext } from '../types.js'
import { isCommentLine } from '../utils/patterns.js'

// Patterns for unsafe SQL construction
const SQL_INJECTION_PATTERNS = [
  // Template literals with SQL keywords and interpolation
  { pattern: /`\s*(?:SELECT|INSERT|UPDATE|DELETE|DROP|ALTER|CREATE)\b[^`]*\$\{/, message: 'SQL query built with template literal interpolation — use parameterized queries' },
  // String concatenation with SQL
  { pattern: /(?:SELECT|INSERT|UPDATE|DELETE|DROP)\b.*['"]?\s*\+\s*\w/, message: 'SQL query built with string concatenation — use parameterized queries' },
  // .query() or .execute() with template literal
  { pattern: /\.(?:query|execute|raw)\s*\(\s*`[^`]*\$\{/, message: 'Database query with template literal interpolation — use parameterized queries' },
]

export const sqlInjectionRule: Rule = {
  id: 'sql-injection',
  name: 'SQL Injection Risk',
  description: 'Detects SQL queries built with string interpolation or concatenation',
  category: 'security',
  severity: 'critical',
  fileExtensions: ['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs'],

  check(file: FileContext, _project: ProjectContext): Finding[] {
    const findings: Finding[] = []

    for (let i = 0; i < file.lines.length; i++) {
      if (isCommentLine(file.lines, i, file.commentMap)) continue

      const line = file.lines[i]

      for (const { pattern, message } of SQL_INJECTION_PATTERNS) {
        if (pattern.test(line)) {
          findings.push({
            ruleId: 'sql-injection',
            file: file.relativePath,
            line: i + 1,
            column: 1,
            message,
            severity: 'critical',
            category: 'security',
          })
          break // One finding per line is enough
        }
      }
    }

    return findings
  },
}
