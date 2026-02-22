import type { Rule, Finding, FileContext, ProjectContext } from '../types.js'
import { isCommentLine, isTestFile, isScriptFile, findLoopBodies } from '../utils/patterns.js'
import { findLoopsAST } from '../utils/ast.js'

// Only match calls that START a query — not chain methods (.from, .select, .eq)
const DB_CALL_PATTERN = /(?:prisma\.\w+\.\w+\(|\.findUnique\s*\(|\.findFirst\s*\(|\.findMany\s*\(|\.insert\s*\(|\.upsert\s*\(|fetch\s*\()/

// Detect Promise.all(items.map(...)) batching patterns
const PROMISE_ALL_MAP = /Promise\.(?:all|allSettled)\s*\(\s*\w+\.map\s*\(/

export const noNPlusOneRule: Rule = {
  id: 'no-n-plus-one',
  name: 'No N+1 Queries',
  description: 'Detects database or fetch calls inside loops (N+1 query pattern)',
  category: 'performance',
  severity: 'warning',
  fileExtensions: ['ts', 'tsx', 'js', 'jsx'],

  check(file: FileContext, _project: ProjectContext): Finding[] {
    if (isTestFile(file.relativePath)) return []
    if (isScriptFile(file.relativePath)) return []

    // Check for Promise.all(items.map(...)) pattern — this IS batching, skip the whole file
    // if the .map callback happens to match our loop detection
    const promiseAllMapLines = new Set<number>()
    for (let i = 0; i < file.lines.length; i++) {
      if (PROMISE_ALL_MAP.test(file.lines[i])) {
        // Mark a range around the Promise.all as safe
        for (let j = Math.max(0, i - 1); j < Math.min(file.lines.length, i + 20); j++) {
          promiseAllMapLines.add(j)
        }
      }
    }

    const findings: Finding[] = []

    // Use AST-based loop detection if available, fall back to brace counting
    let loops: { loopLine: number; bodyStart: number; bodyEnd: number }[]
    if (file.ast) {
      try {
        loops = findLoopsAST(file.ast)
      } catch {
        loops = findLoopBodies(file.lines, file.commentMap)
      }
    } else {
      loops = findLoopBodies(file.lines, file.commentMap)
    }

    const reported = new Set<number>() // one finding per loop

    for (const loop of loops) {
      if (reported.has(loop.loopLine)) continue

      // Skip loops that are inside Promise.all(items.map(...))
      if (promiseAllMapLines.has(loop.loopLine)) continue

      for (let i = loop.bodyStart; i <= loop.bodyEnd; i++) {
        if (isCommentLine(file.lines, i, file.commentMap)) continue
        const line = file.lines[i]

        // Skip if this line is inside a Promise.all map
        if (promiseAllMapLines.has(i)) continue

        const match = DB_CALL_PATTERN.exec(line)
        if (match) {
          reported.add(loop.loopLine)
          findings.push({
            ruleId: 'no-n-plus-one',
            file: file.relativePath,
            line: i + 1,
            column: match.index + 1,
            message: 'Database/fetch call inside loop — potential N+1 query, consider batching',
            severity: 'warning',
            category: 'performance',
            fix: 'Use eager loading (include/join) or batch the queries outside the loop',
          })
          break // one finding per loop body
        }
      }
    }

    return findings
  },
}
