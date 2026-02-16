import type { Rule, Finding, FileContext, ProjectContext } from '../types.js'
import { isApiRoute } from '../utils/patterns.js'

export const errorHandlingRule: Rule = {
  id: 'error-handling',
  name: 'Missing Error Handling',
  description: 'Detects API routes without try/catch and empty catch blocks',
  category: 'reliability',
  severity: 'warning',
  fileExtensions: ['ts', 'tsx', 'js', 'jsx'],

  check(file: FileContext, _project: ProjectContext): Finding[] {
    const findings: Finding[] = []

    // Check 1: API routes without try/catch
    if (isApiRoute(file.relativePath)) {
      const hasTryCatch = /try\s*\{/.test(file.content)
      if (!hasTryCatch) {
        let handlerLine = 1
        for (let i = 0; i < file.lines.length; i++) {
          if (/export\s+(async\s+)?function\s+(GET|POST|PUT|PATCH|DELETE|handler)/i.test(file.lines[i])) {
            handlerLine = i + 1
            break
          }
        }
        findings.push({
          ruleId: 'error-handling',
          file: file.relativePath,
          line: handlerLine,
          column: 1,
          message: 'API route handler has no try/catch block',
          severity: 'warning',
          category: 'reliability',
        })
      }
    }

    // Check 2: Empty catch blocks
    for (let i = 0; i < file.lines.length; i++) {
      const line = file.lines[i]
      // catch (...) {} or catch { } on same line
      if (/catch\s*(\([^)]*\))?\s*\{\s*\}/.test(line)) {
        findings.push({
          ruleId: 'error-handling',
          file: file.relativePath,
          line: i + 1,
          column: line.indexOf('catch') + 1,
          message: 'Empty catch block silently swallows errors',
          severity: 'warning',
          category: 'reliability',
        })
        continue
      }

      // Multi-line empty catch: catch (...) {\n}
      if (/catch\s*(\([^)]*\))?\s*\{\s*$/.test(line)) {
        const nextLine = file.lines[i + 1]?.trim()
        if (nextLine === '}') {
          findings.push({
            ruleId: 'error-handling',
            file: file.relativePath,
            line: i + 1,
            column: line.indexOf('catch') + 1,
            message: 'Empty catch block silently swallows errors',
            severity: 'warning',
            category: 'reliability',
          })
        }
      }
    }

    return findings
  },
}
