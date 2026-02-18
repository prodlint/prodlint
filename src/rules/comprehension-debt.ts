import type { Rule, Finding, FileContext, ProjectContext } from '../types.js'
import { isTestFile, isScriptFile, isConfigFile, isCommentLine } from '../utils/patterns.js'

const MAX_FUNCTION_LENGTH = 80
const MAX_NESTING_DEPTH = 5
const MAX_PARAMS = 5

// Content-heavy files where long components are expected (mostly JSX markup)
function isContentFile(relativePath: string): boolean {
  return /(?:^|\/)content\//.test(relativePath) ||
    /(?:^|\/)blog\//.test(relativePath) ||
    /\(legal\)\//.test(relativePath)
}

export const comprehensionDebtRule: Rule = {
  id: 'comprehension-debt',
  name: 'Comprehension Debt',
  description: 'Detects code that is hard to understand — long functions, deep nesting, excessive parameters',
  category: 'ai-quality',
  severity: 'info',
  fileExtensions: ['ts', 'tsx', 'js', 'jsx'],

  check(file: FileContext, _project: ProjectContext): Finding[] {
    if (isTestFile(file.relativePath)) return []
    if (isScriptFile(file.relativePath)) return []
    if (isConfigFile(file.relativePath)) return []
    if (isContentFile(file.relativePath)) return []

    const findings: Finding[] = []

    // Track function bodies via brace counting
    let fnStart = -1
    let fnName = ''
    let braceDepth = 0
    let maxDepthInFn = 0
    let fnBraceStart = -1
    let inFunction = false

    for (let i = 0; i < file.lines.length; i++) {
      if (isCommentLine(file.lines, i, file.commentMap)) continue
      const line = file.lines[i]
      const trimmed = line.trim()

      // Detect function declarations
      const fnMatch = trimmed.match(/(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*\(([^)]*)\)/)
        ?? trimmed.match(/(?:export\s+)?const\s+(\w+)\s*=\s*(?:async\s+)?\(([^)]*)\)\s*(?:=>|:)/)
      if (fnMatch && !inFunction) {
        fnName = fnMatch[1]
        fnStart = i

        // Check parameter count
        const params = fnMatch[2].split(',').filter(p => p.trim()).length
        if (params > MAX_PARAMS) {
          findings.push({
            ruleId: 'comprehension-debt',
            file: file.relativePath,
            line: i + 1,
            column: 1,
            message: `${fnName}() has ${params} parameters (max ${MAX_PARAMS}) — hard to call correctly`,
            severity: 'info',
            category: 'ai-quality',
          })
        }
      }

      // Track brace depth
      for (const ch of line) {
        if (ch === '{') {
          braceDepth++
          if (fnStart >= 0 && fnBraceStart === -1) {
            fnBraceStart = braceDepth
            inFunction = true
          }
          if (inFunction && braceDepth - fnBraceStart > maxDepthInFn) {
            maxDepthInFn = braceDepth - fnBraceStart
          }
        }
        if (ch === '}') {
          braceDepth--
          if (inFunction && braceDepth < fnBraceStart) {
            // Function ended
            const length = i - fnStart + 1
            if (length > MAX_FUNCTION_LENGTH) {
              findings.push({
                ruleId: 'comprehension-debt',
                file: file.relativePath,
                line: fnStart + 1,
                column: 1,
                message: `${fnName}() is ${length} lines long (max ${MAX_FUNCTION_LENGTH}) — consider splitting`,
                severity: 'info',
                category: 'ai-quality',
              })
            }
            if (maxDepthInFn > MAX_NESTING_DEPTH) {
              findings.push({
                ruleId: 'comprehension-debt',
                file: file.relativePath,
                line: fnStart + 1,
                column: 1,
                message: `${fnName}() has nesting depth ${maxDepthInFn} (max ${MAX_NESTING_DEPTH}) — flatten with early returns`,
                severity: 'info',
                category: 'ai-quality',
              })
            }

            inFunction = false
            fnStart = -1
            fnBraceStart = -1
            maxDepthInFn = 0
            fnName = ''
          }
        }
      }
    }

    return findings
  },
}
