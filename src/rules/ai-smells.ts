import type { Rule, Finding, FileContext, ProjectContext } from '../types.js'

// Threshold for "too many console.logs"
const CONSOLE_LOG_THRESHOLD = 5

// Threshold for "too many any types"
const ANY_TYPE_THRESHOLD = 5

// Threshold for commented-out code lines (consecutive)
const COMMENTED_CODE_THRESHOLD = 3

export const aiSmellsRule: Rule = {
  id: 'ai-smells',
  name: 'AI Code Smells',
  description: 'Detects TODOs, placeholder functions, excessive console.log, any types, and commented-out code',
  category: 'ai-quality',
  severity: 'info', // Default, individual findings may vary
  fileExtensions: ['ts', 'tsx', 'js', 'jsx'],

  check(file: FileContext, _project: ProjectContext): Finding[] {
    const findings: Finding[] = []

    let consoleLogCount = 0
    let anyTypeCount = 0
    let commentedCodeRun = 0

    for (let i = 0; i < file.lines.length; i++) {
      const line = file.lines[i]
      const trimmed = line.trim()

      // TODO / FIXME / HACK / XXX comments
      const todoMatch = trimmed.match(/\/\/\s*(TODO|FIXME|HACK|XXX)\b(.*)/)
      if (todoMatch) {
        findings.push({
          ruleId: 'ai-smells',
          file: file.relativePath,
          line: i + 1,
          column: line.indexOf(todoMatch[1]) + 1,
          message: `${todoMatch[1]} comment: ${todoMatch[2].trim() || '(no description)'}`,
          severity: 'info',
          category: 'ai-quality',
        })
      }

      // Placeholder functions (empty function bodies or "not implemented")
      if (/(?:throw new Error|throw Error)\s*\(\s*['"]not implemented['"]/i.test(line)) {
        findings.push({
          ruleId: 'ai-smells',
          file: file.relativePath,
          line: i + 1,
          column: 1,
          message: 'Placeholder "not implemented" function',
          severity: 'warning',
          category: 'ai-quality',
        })
      }

      // console.log (not console.error/warn/info)
      if (/console\.log\s*\(/.test(line) && !trimmed.startsWith('//')) {
        consoleLogCount++
      }

      // Excessive `any` types
      if (/:\s*any\b/.test(line) || /as\s+any\b/.test(line) || /<any>/.test(line)) {
        anyTypeCount++
      }

      // Commented-out code detection (lines starting with // that look like code)
      if (trimmed.startsWith('//') && !todoMatch) {
        const commentContent = trimmed.slice(2).trim()
        // Looks like code if it has typical code patterns
        const looksLikeCode = /^(import |export |const |let |var |function |if |for |while |return |await |async |class |switch )/.test(commentContent) ||
          /[{};=]$/.test(commentContent) ||
          /^\w+\(/.test(commentContent)

        if (looksLikeCode) {
          commentedCodeRun++
          if (commentedCodeRun === COMMENTED_CODE_THRESHOLD) {
            findings.push({
              ruleId: 'ai-smells',
              file: file.relativePath,
              line: i + 1 - COMMENTED_CODE_THRESHOLD + 1,
              column: 1,
              message: `${COMMENTED_CODE_THRESHOLD}+ consecutive lines of commented-out code`,
              severity: 'info',
              category: 'ai-quality',
            })
          }
        } else {
          commentedCodeRun = 0
        }
      } else {
        commentedCodeRun = 0
      }
    }

    // Report excessive console.log
    if (consoleLogCount > CONSOLE_LOG_THRESHOLD) {
      findings.push({
        ruleId: 'ai-smells',
        file: file.relativePath,
        line: 1,
        column: 1,
        message: `${consoleLogCount} console.log statements (consider a proper logger)`,
        severity: 'warning',
        category: 'ai-quality',
      })
    }

    // Report excessive any types
    if (anyTypeCount > ANY_TYPE_THRESHOLD) {
      findings.push({
        ruleId: 'ai-smells',
        file: file.relativePath,
        line: 1,
        column: 1,
        message: `${anyTypeCount} uses of "any" type (consider proper typing)`,
        severity: 'warning',
        category: 'ai-quality',
      })
    }

    return findings
  },
}
