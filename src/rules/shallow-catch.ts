import type { Rule, Finding, FileContext, ProjectContext } from '../types.js'
import { isCommentLine, isTestFile, isScriptFile } from '../utils/patterns.js'

/**
 * Score a catch block body on error handling depth:
 * 0 = empty catch
 * 1 = console.log only (decorative)
 * 2 = console.error or logs the error object
 * 3 = re-throws or returns error response
 */
function scoreCatchBody(bodyLines: string[]): { score: number; label: string } {
  if (bodyLines.length === 0 || bodyLines.every(l => l.trim() === '')) {
    return { score: 0, label: 'empty catch' }
  }

  const body = bodyLines.join('\n')
  let score = 0

  // Logs at all?
  if (/console\.(log|warn|error|info)\s*\(/.test(body)) score = 1
  // Logs the error object specifically?
  if (/console\.(error|warn)\s*\(/.test(body) && /\b(err|error|e)\b/.test(body)) score = 2
  // Re-throws, returns error response, or sets error state?
  if (/\bthrow\b/.test(body) ||
      /\breturn\b.*(?:error|err|status|Response|NextResponse|json)/.test(body) ||
      /\bset\w*Error\s*\(/.test(body) ||
      /\bres\.\w+\s*\(/.test(body)) {
    score = 3
  }

  const labels: Record<number, string> = {
    0: 'empty catch',
    1: 'catch only logs (no recovery or propagation)',
    2: 'catch logs error but does not propagate or recover',
    3: 'catch handles error properly',
  }

  return { score, label: labels[score] }
}

export const shallowCatchRule: Rule = {
  id: 'shallow-catch',
  name: 'Shallow Error Handler',
  description: 'Detects catch blocks that exist but do nothing useful — decorative error handling',
  category: 'reliability',
  severity: 'warning',
  fileExtensions: ['ts', 'tsx', 'js', 'jsx'],

  check(file: FileContext, _project: ProjectContext): Finding[] {
    if (isTestFile(file.relativePath)) return []
    if (isScriptFile(file.relativePath)) return []

    const findings: Finding[] = []

    for (let i = 0; i < file.lines.length; i++) {
      if (isCommentLine(file.lines, i, file.commentMap)) continue
      const trimmed = file.lines[i].trim()

      // Detect catch block opening
      if (!/\bcatch\s*\(/.test(trimmed) && !/\bcatch\s*\{/.test(trimmed)) continue

      // Find the opening brace of the catch body
      let braceStart = -1
      for (let j = i; j < Math.min(i + 3, file.lines.length); j++) {
        if (file.lines[j].includes('{')) {
          braceStart = j
          break
        }
      }
      if (braceStart === -1) continue

      // Count braces to find catch body end (string-aware)
      // On braceStart line, start from the '{' to avoid counting try's closing '}'
      let depth = 0
      let bodyEnd = braceStart
      let inSingle = false
      let inDouble = false
      let inTemplate = false
      for (let j = braceStart; j < file.lines.length; j++) {
        const line = file.lines[j]
        const startPos = (j === braceStart) ? line.indexOf('{') : 0
        for (let k = startPos; k < line.length; k++) {
          const ch = line[k]
          const prev = k > 0 ? line[k - 1] : ''
          const escaped = prev === '\\' && (k < 2 || line[k - 2] !== '\\')

          if (!escaped) {
            if (ch === "'" && !inDouble && !inTemplate) { inSingle = !inSingle; continue }
            if (ch === '"' && !inSingle && !inTemplate) { inDouble = !inDouble; continue }
            if (ch === '`' && !inSingle && !inDouble) { inTemplate = !inTemplate; continue }
          }

          if (inSingle || inDouble || inTemplate) continue

          if (ch === '{') depth++
          if (ch === '}') {
            depth--
            if (depth === 0) {
              bodyEnd = j
              break
            }
          }
        }
        if (depth === 0) break
      }

      const bodyLines = file.lines.slice(braceStart + 1, bodyEnd)
      const { score, label } = scoreCatchBody(bodyLines)

      if (score <= 1) {
        findings.push({
          ruleId: 'shallow-catch',
          file: file.relativePath,
          line: i + 1,
          column: file.lines[i].indexOf('catch') + 1,
          message: score === 0
            ? 'Empty catch block — errors are silently swallowed'
            : `Decorative error handler: ${label}`,
          severity: score === 0 ? 'warning' : 'info',
          category: 'reliability',
        })
      }

      // Skip past the catch body
      i = bodyEnd
    }

    return findings
  },
}
