import type { Rule, Finding, FileContext, ProjectContext } from '../types.js'
import { isCommentLine } from '../utils/patterns.js'

// Only match calls that START a promise chain (not chained methods like .from/.select)
const ASYNC_CALL_PATTERN = /(?:fetch\s*\(|prisma\.\w+\.\w+\(|\.findMany\s*\(|\.findFirst\s*\(|\.findUnique\s*\(|\.upsert\s*\()/

// Line-level indicators that the promise IS handled
const HANDLED_PATTERNS = [
  /\bawait\b/,
  /\breturn\b/,
  /\bconst\s+\w/,
  /\blet\s+\w/,
  /\bvar\s+\w/,
  /=\s*(?:await\b)?/,
  /\.then\s*\(/,
  /\.catch\s*\(/,
  /void\s+/,
  /Promise\.all/,
  /Promise\.allSettled/,
  /Promise\.race/,
]

// Supabase/ORM chain starters that are always part of a larger expression
const CHAIN_START_PATTERNS = [
  /\.from\s*\(/,
  /\.rpc\s*\(/,
]

export const unhandledPromiseRule: Rule = {
  id: 'unhandled-promise',
  name: 'Unhandled Promise',
  description: 'Detects async calls (fetch, DB) without await, return, or assignment',
  category: 'reliability',
  severity: 'warning',
  fileExtensions: ['ts', 'tsx', 'js', 'jsx'],

  check(file: FileContext, _project: ProjectContext): Finding[] {
    const findings: Finding[] = []

    for (let i = 0; i < file.lines.length; i++) {
      if (isCommentLine(file.lines, i, file.commentMap)) continue
      const line = file.lines[i]
      const trimmed = line.trim()

      // Skip lines that are chained method calls (start with .)
      if (/^\.\w/.test(trimmed)) continue

      // Skip lines inside string literals (rough: line starts inside a quote context)
      if (/^['"`]/.test(trimmed)) continue

      const asyncMatch = ASYNC_CALL_PATTERN.exec(trimmed)
      if (!asyncMatch) continue

      // Check if the promise is handled on this line
      const isHandled = HANDLED_PATTERNS.some(p => p.test(trimmed))
      if (isHandled) continue

      // Check if this line is part of a Supabase/ORM chain that's handled above
      const isChainContinuation = CHAIN_START_PATTERNS.some(p => p.test(trimmed))
      if (isChainContinuation) {
        // Look upward for the chain start with await/assignment
        let chainHandled = false
        for (let j = i - 1; j >= Math.max(0, i - 10); j--) {
          const prevTrimmed = file.lines[j].trim()
          if (prevTrimmed === '' || prevTrimmed.endsWith(';')) break
          if (/\bawait\b/.test(prevTrimmed) || /\bconst\s+\w/.test(prevTrimmed) || /\blet\s+\w/.test(prevTrimmed) || /=\s*await\b/.test(prevTrimmed) || /\breturn\b/.test(prevTrimmed)) {
            chainHandled = true
            break
          }
        }
        if (chainHandled) continue
      }

      // Check previous lines for multiline chain (await supabase\n  .from(...)\n  .update(...))
      let handledAbove = false
      for (let j = i - 1; j >= Math.max(0, i - 5); j--) {
        const prevTrimmed = file.lines[j].trim()
        // If we hit an empty line or a line that doesn't look like a chain, stop
        if (prevTrimmed === '' || prevTrimmed.endsWith(';')) break
        if (/\bawait\b/.test(prevTrimmed) || /\bconst\s+\w/.test(prevTrimmed) || /\blet\s+\w/.test(prevTrimmed) || /=\s*await\b/.test(prevTrimmed)) {
          handledAbove = true
          break
        }
      }
      if (handledAbove) continue

      const col = ASYNC_CALL_PATTERN.exec(line)
      findings.push({
        ruleId: 'unhandled-promise',
        file: file.relativePath,
        line: i + 1,
        column: col ? col.index + 1 : 1,
        message: 'Async call without await, return, or assignment — promise result is lost',
        severity: 'warning',
        category: 'reliability',
      })
    }

    return findings
  },
}
