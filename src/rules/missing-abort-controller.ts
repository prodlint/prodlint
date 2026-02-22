import type { Rule, Finding, FileContext, ProjectContext } from '../types.js'
import { isCommentLine, isTestFile, isApiRoute } from '../utils/patterns.js'

const HTTP_CALL = /\b(fetch|axios)\s*[.(]/

const HAS_TIMEOUT = [
  /AbortController/,
  /abort/i,
  /signal\s*:/,
  /timeout\s*:/,
  /timeout\s*=/,
  /setTimeout.*abort/s,
  /axios\.create\s*\([^)]*timeout/s,
]

const BACKGROUND_PATTERN = /\b(setInterval|cron|schedule|createWorker|bullmq|agenda|queue\.process)\b/

function isBackgroundFile(file: FileContext): boolean {
  if (BACKGROUND_PATTERN.test(file.content)) return true
  const p = file.relativePath.toLowerCase()
  return /\b(cron|jobs?|workers?|queues?|tasks?|background)\b/.test(p)
}

export const missingAbortControllerRule: Rule = {
  id: 'missing-abort-controller',
  name: 'Missing Abort Controller',
  description: 'Detects fetch/axios calls without timeout or AbortController — requests can hang indefinitely',
  category: 'performance',
  severity: 'info',
  fileExtensions: ['ts', 'tsx', 'js', 'jsx'],

  check(file: FileContext, _project: ProjectContext): Finding[] {
    if (isTestFile(file.relativePath)) return []

    const isRelevant = isApiRoute(file.relativePath)
      || /['"]use server['"]/.test(file.content)
      || isBackgroundFile(file)
    if (!isRelevant) return []
    if (!HTTP_CALL.test(file.content)) return []

    const hasTimeout = HAS_TIMEOUT.some(p => p.test(file.content))
    if (hasTimeout) return []

    // Find the first fetch/axios call
    let reportLine = 1
    let matchedCall = 'fetch'
    for (let i = 0; i < file.lines.length; i++) {
      if (isCommentLine(file.lines, i, file.commentMap)) continue
      const m = file.lines[i].match(HTTP_CALL)
      if (m) {
        reportLine = i + 1
        matchedCall = m[1]
        break
      }
    }

    const isFetch = matchedCall === 'fetch'
    return [{
      ruleId: 'missing-abort-controller',
      file: file.relativePath,
      line: reportLine,
      column: 1,
      message: `${matchedCall}() without timeout or AbortController — request will hang indefinitely if the upstream server doesn't respond`,
      severity: 'info',
      category: 'performance',
      fix: isFetch
        ? 'Add a timeout: const controller = new AbortController(); setTimeout(() => controller.abort(), 10000); fetch(url, { signal: controller.signal })'
        : 'Add a timeout: axios.get(url, { timeout: 10000 }) or configure in axios.create({ timeout: 10000 })',
    }]
  },
}
