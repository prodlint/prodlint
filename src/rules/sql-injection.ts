import type { Rule, Finding, FileContext, ProjectContext } from '../types.js'
import { isCommentLine } from '../utils/patterns.js'
import { walkAST, isTaggedTemplateSql } from '../utils/ast.js'
import { SQL_SAFE_ORMS } from '../utils/frameworks.js'
import type { TaggedTemplateExpression } from '@babel/types'

// Patterns for unsafe SQL construction
const SQL_INJECTION_PATTERNS = [
  // Template literals with SQL keywords and interpolation
  { pattern: /`\s*(?:SELECT|INSERT|UPDATE|DELETE|DROP|ALTER|CREATE)\b[^`]*\$\{/, message: 'SQL query built with template literal interpolation — use parameterized queries' },
  // String concatenation with SQL
  { pattern: /(?:SELECT|INSERT|UPDATE|DELETE|DROP)\b.*['"]?\s*\+\s*\w/, message: 'SQL query built with string concatenation — use parameterized queries' },
  // .query() or .execute() with template literal
  { pattern: /\.(?:query|execute|raw)\s*\(\s*`[^`]*\$\{/, message: 'Database query with template literal interpolation — use parameterized queries' },
]

// Regex-based tagged template detection (fallback when no AST)
const TAGGED_TEMPLATE_PREFIX = /\b(?:sql|Prisma\.sql|db\.sql|db\.query)\s*`/

// Regex for parameterized query patterns: .query(sql, [params])
const PARAMETERIZED_QUERY = /\.(?:query|execute)\s*\([^,]+,\s*\[/

export const sqlInjectionRule: Rule = {
  id: 'sql-injection',
  name: 'SQL Injection Risk',
  description: 'Detects SQL queries built with string interpolation or concatenation',
  category: 'security',
  severity: 'critical',
  fileExtensions: ['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs'],

  check(file: FileContext, project: ProjectContext): Finding[] {
    const findings: Finding[] = []

    // If AST is available, build a set of safe tagged template line ranges
    const safeTaggedLines = new Set<number>()
    if (file.ast) {
      try {
        walkAST(file.ast.program, (node) => {
          if (node.type === 'TaggedTemplateExpression') {
            const tagged = node as TaggedTemplateExpression
            if (isTaggedTemplateSql(tagged) && tagged.loc) {
              for (let l = tagged.loc.start.line; l <= tagged.loc.end.line; l++) {
                safeTaggedLines.add(l)
              }
            }
          }
        })
      } catch {
        // AST walk failed, fall back to regex
      }
    }

    // Determine if project uses a safe ORM
    const usesORM = [...project.detectedFrameworks].some(f => SQL_SAFE_ORMS.has(f))

    for (let i = 0; i < file.lines.length; i++) {
      if (isCommentLine(file.lines, i, file.commentMap)) continue

      const line = file.lines[i]
      const lineNum = i + 1 // 1-indexed

      // Skip lines inside AST-detected tagged templates
      if (safeTaggedLines.has(lineNum)) continue

      // Regex fallback: skip lines that are tagged template literals
      if (!file.ast && TAGGED_TEMPLATE_PREFIX.test(line)) continue

      // Skip parameterized queries (.query(sql, [params]))
      if (PARAMETERIZED_QUERY.test(line)) continue

      for (const { pattern, message } of SQL_INJECTION_PATTERNS) {
        if (pattern.test(line)) {
          // If project uses an ORM that parameterizes by default, downgrade to warning
          const severity = usesORM ? 'warning' as const : 'critical' as const

          findings.push({
            ruleId: 'sql-injection',
            file: file.relativePath,
            line: lineNum,
            column: 1,
            message,
            severity,
            category: 'security',
            fix: "Use parameterized queries: db.query('SELECT * FROM users WHERE id = $1', [id])",
          })
          break // One finding per line is enough
        }
      }
    }

    return findings
  },
}
