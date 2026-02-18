import type { Rule, Finding, FileContext, ProjectContext } from '../types.js'
import { isCommentLine, isTestFile, isScriptFile, findLoopBodies } from '../utils/patterns.js'

// Only match calls that START a query — not chain methods (.from, .select, .eq)
const DB_CALL_PATTERN = /(?:prisma\.\w+\.\w+\(|\.findUnique\s*\(|\.findFirst\s*\(|\.findMany\s*\(|\.insert\s*\(|\.upsert\s*\(|fetch\s*\()/

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

    const findings: Finding[] = []
    const loops = findLoopBodies(file.lines, file.commentMap)
    const reported = new Set<number>() // one finding per loop

    for (const loop of loops) {
      if (reported.has(loop.loopLine)) continue

      for (let i = loop.bodyStart; i <= loop.bodyEnd; i++) {
        if (isCommentLine(file.lines, i, file.commentMap)) continue
        const line = file.lines[i]

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
          })
          break // one finding per loop body
        }
      }
    }

    return findings
  },
}
