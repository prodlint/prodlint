import type { Rule, Finding, FileContext, ProjectContext } from '../types.js'
import { isCommentLine, isTestFile, isApiRoute } from '../utils/patterns.js'

const FETCH_CALL = /\bfetch\s*\(/

const HAS_TIMEOUT = [
  /AbortController/,
  /abort/i,
  /signal\s*:/,
  /timeout/i,
  /setTimeout.*abort/s,
]

export const missingAbortControllerRule: Rule = {
  id: 'missing-abort-controller',
  name: 'Missing Abort Controller',
  description: 'Detects fetch calls in API routes without timeout or AbortController — requests can hang indefinitely',
  category: 'performance',
  severity: 'info',
  fileExtensions: ['ts', 'tsx', 'js', 'jsx'],

  check(file: FileContext, _project: ProjectContext): Finding[] {
    if (isTestFile(file.relativePath)) return []
    if (!isApiRoute(file.relativePath) && !/['"]use server['"]/.test(file.content)) return []
    if (!FETCH_CALL.test(file.content)) return []

    const hasTimeout = HAS_TIMEOUT.some(p => p.test(file.content))
    if (hasTimeout) return []

    // Find the first fetch call
    let reportLine = 1
    for (let i = 0; i < file.lines.length; i++) {
      if (isCommentLine(file.lines, i, file.commentMap)) continue
      if (FETCH_CALL.test(file.lines[i])) {
        reportLine = i + 1
        break
      }
    }

    return [{
      ruleId: 'missing-abort-controller',
      file: file.relativePath,
      line: reportLine,
      column: 1,
      message: 'fetch() without timeout or AbortController — request will hang indefinitely if the upstream server doesn\'t respond',
      severity: 'info',
      category: 'performance',
      fix: 'Add a timeout: const controller = new AbortController(); setTimeout(() => controller.abort(), 10000); fetch(url, { signal: controller.signal })',
    }]
  },
}
