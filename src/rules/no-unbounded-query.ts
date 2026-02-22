import type { Rule, Finding, FileContext, ProjectContext } from '../types.js'
import { isCommentLine, isTestFile, isScriptFile } from '../utils/patterns.js'

export const noUnboundedQueryRule: Rule = {
  id: 'no-unbounded-query',
  name: 'No Unbounded Query',
  description: 'Detects database queries without LIMIT/take constraints',
  category: 'performance',
  severity: 'warning',
  fileExtensions: ['ts', 'tsx', 'js', 'jsx'],

  check(file: FileContext, _project: ProjectContext): Finding[] {
    if (isTestFile(file.relativePath)) return []
    if (isScriptFile(file.relativePath)) return []

    const findings: Finding[] = []

    for (let i = 0; i < file.lines.length; i++) {
      if (isCommentLine(file.lines, i, file.commentMap)) continue
      const line = file.lines[i]

      // findMany() with no arguments — always unbounded
      if (/\.findMany\s*\(\s*\)/.test(line)) {
        findings.push({
          ruleId: 'no-unbounded-query',
          file: file.relativePath,
          line: i + 1,
          column: line.indexOf('.findMany') + 1,
          message: '.findMany() without take/limit — query may return unbounded results',
          severity: 'warning',
          category: 'performance',
          fix: 'Add a LIMIT clause or use pagination to prevent unbounded result sets',
        })
        continue
      }

      // findMany({ ... }) — check 6-line context for take/limit
      if (/\.findMany\s*\(\s*\{/.test(line)) {
        const context = file.lines.slice(i, Math.min(i + 6, file.lines.length)).join(' ')
        if (!/\btake\s*:/.test(context) && !/\blimit\s*[:(]/.test(context)) {
          findings.push({
            ruleId: 'no-unbounded-query',
            file: file.relativePath,
            line: i + 1,
            column: line.indexOf('.findMany') + 1,
            message: '.findMany() without take — add pagination or limit',
            severity: 'warning',
            category: 'performance',
            fix: 'Add a LIMIT clause or use pagination to prevent unbounded result sets',
          })
        }
        continue
      }

      // .select('*') without .limit() — but allow when query is bounded by .eq(), .single(), .maybeSingle()
      if (/\.select\s*\(\s*['"`]\*['"`]\s*\)/.test(line)) {
        const context = file.lines.slice(Math.max(0, i - 2), Math.min(i + 4, file.lines.length)).join(' ')
        const hasBound = /\.limit\s*\(/.test(context)
          || /\.range\s*\(/.test(context)
          || /LIMIT\s+\d/i.test(context)
          || /\.eq\s*\(/.test(context)
          || /\.single\s*\(/.test(context)
          || /\.maybeSingle\s*\(/.test(context)
          || /\.match\s*\(/.test(context)
        if (!hasBound) {
          findings.push({
            ruleId: 'no-unbounded-query',
            file: file.relativePath,
            line: i + 1,
            column: line.indexOf('.select') + 1,
            message: ".select('*') without .limit() or filter — add pagination or a where clause",
            severity: 'warning',
            category: 'performance',
            fix: 'Add a LIMIT clause or use pagination to prevent unbounded result sets',
          })
        }
      }
    }

    return findings
  },
}
