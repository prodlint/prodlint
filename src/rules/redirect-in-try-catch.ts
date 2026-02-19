import type { Rule, Finding, FileContext, ProjectContext } from '../types.js'
import { isCommentLine, isTestFile } from '../utils/patterns.js'

export const redirectInTryCatchRule: Rule = {
  id: 'redirect-in-try-catch',
  name: 'Redirect Inside Try/Catch',
  description: 'Detects Next.js redirect() inside try/catch blocks — redirect throws internally and the catch swallows it',
  category: 'reliability',
  severity: 'critical',
  fileExtensions: ['ts', 'tsx', 'js', 'jsx'],

  check(file: FileContext, _project: ProjectContext): Finding[] {
    if (isTestFile(file.relativePath)) return []
    if (!/redirect\s*\(/.test(file.content)) return []

    const findings: Finding[] = []
    let tryDepth = 0

    for (let i = 0; i < file.lines.length; i++) {
      if (isCommentLine(file.lines, i, file.commentMap)) continue
      const line = file.lines[i]
      const trimmed = line.trim()

      // Track try blocks via braces
      if (/\btry\s*\{/.test(trimmed) || trimmed === 'try {') {
        tryDepth++
      }

      // Count braces for nesting — simplified: track catch blocks too
      if (/\}\s*catch\s*[\s(]/.test(trimmed)) {
        // A catch after try means we're still in the try/catch construct
        // tryDepth stays the same until the catch block closes
      }

      if (tryDepth > 0) {
        const match = /\bredirect\s*\(/.exec(line)
        if (match && !/\/\//.test(line.slice(0, match.index))) {
          findings.push({
            ruleId: 'redirect-in-try-catch',
            file: file.relativePath,
            line: i + 1,
            column: match.index + 1,
            message: 'redirect() inside try/catch — Next.js redirect throws internally, the catch block will intercept it',
            severity: 'critical',
            category: 'reliability',
            fix: 'Move redirect() outside the try/catch block, or re-throw redirect errors in the catch: if (e instanceof Error && e.message === "NEXT_REDIRECT") throw e',
          })
        }
      }

      // Simple brace tracking for try depth
      for (const ch of trimmed) {
        if (ch === '{' && tryDepth > 0) { /* already counted above */ }
      }

      // When we see the closing of a try/catch/finally construct, reduce depth
      if (tryDepth > 0 && /^\}\s*$/.test(trimmed)) {
        // Check if the next non-empty line starts a catch or finally
        let nextLine = ''
        for (let j = i + 1; j < file.lines.length; j++) {
          nextLine = file.lines[j].trim()
          if (nextLine) break
        }
        if (!/^catch\b/.test(nextLine) && !/^finally\b/.test(nextLine)) {
          tryDepth--
        }
      }
    }

    return findings
  },
}
