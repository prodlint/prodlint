import type { Rule, Finding, FileContext, ProjectContext } from '../types.js'
import { isCommentLine, findLoopBodies } from '../utils/patterns.js'

const DYNAMIC_IMPORT_PATTERN = /\bimport\s*\(/

export const noDynamicImportLoopRule: Rule = {
  id: 'no-dynamic-import-loop',
  name: 'No Dynamic Import in Loop',
  description: 'Detects dynamic import() calls inside loops',
  category: 'performance',
  severity: 'warning',
  fileExtensions: ['ts', 'tsx', 'js', 'jsx'],

  check(file: FileContext, _project: ProjectContext): Finding[] {
    const findings: Finding[] = []
    const loops = findLoopBodies(file.lines, file.commentMap)

    for (const loop of loops) {
      for (let i = loop.bodyStart; i <= loop.bodyEnd; i++) {
        if (isCommentLine(file.lines, i, file.commentMap)) continue
        const line = file.lines[i]

        // Skip static imports at top level (import ... from 'x')
        if (/^\s*import\s+/.test(line) && /\bfrom\b/.test(line)) continue

        const match = DYNAMIC_IMPORT_PATTERN.exec(line)
        if (match) {
          findings.push({
            ruleId: 'no-dynamic-import-loop',
            file: file.relativePath,
            line: i + 1,
            column: match.index + 1,
            message: 'Dynamic import() inside loop — move import outside or use Promise.all',
            severity: 'warning',
            category: 'performance',
          })
        }
      }
    }

    return findings
  },
}
