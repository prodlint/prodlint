import type { Rule, Finding, FileContext, ProjectContext } from '../types.js'
import { isCommentLine, isTestFile, isApiRoute } from '../utils/patterns.js'

const USER_INPUT_IN_FETCH = [
  /fetch\s*\(\s*(?:req|request)\.(?:body|query|params|nextUrl)/,
  /fetch\s*\(\s*(?:url|href|endpoint|target|link|src)\s*[,)]/,
  /fetch\s*\(\s*searchParams\.get\s*\(/,
  /fetch\s*\(\s*formData\.get\s*\(/,
  /new\s+URL\s*\(\s*(?:req|request)\.(?:body|query)/,
  /axios\s*[.(]\s*(?:req|request)\.(?:body|query)/,
  /axios\.get\s*\(\s*(?:url|href|endpoint|target|link)\s*[,)]/,
]

const VALIDATION_PATTERNS = [
  /allowlist/i,
  /allowedUrls/i,
  /allowedHosts/i,
  /allowedDomains/i,
  /whitelist/i,
  /validUrl/i,
  /validateUrl/i,
  /URL\.canParse/,
  /new\s+URL\s*\(.*\)\.host/,
  /\.startsWith\s*\(\s*['"]https?:\/\//,
  /\.hostname\s*[!=]==?\s*['"`]/,
]

export const ssrfRiskRule: Rule = {
  id: 'ssrf-risk',
  name: 'SSRF Risk',
  description: 'Detects fetch/HTTP calls with user-controlled URLs without validation — allows attackers to probe internal services',
  category: 'security',
  severity: 'warning',
  fileExtensions: ['ts', 'tsx', 'js', 'jsx'],

  check(file: FileContext, _project: ProjectContext): Finding[] {
    if (isTestFile(file.relativePath)) return []
    if (!isApiRoute(file.relativePath) && !/['"]use server['"]/.test(file.content)) return []

    const hasValidation = VALIDATION_PATTERNS.some(p => p.test(file.content))
    if (hasValidation) return []

    const findings: Finding[] = []

    for (let i = 0; i < file.lines.length; i++) {
      if (isCommentLine(file.lines, i, file.commentMap)) continue
      const line = file.lines[i]

      for (const pattern of USER_INPUT_IN_FETCH) {
        const match = pattern.exec(line)
        if (match) {
          findings.push({
            ruleId: 'ssrf-risk',
            file: file.relativePath,
            line: i + 1,
            column: match.index + 1,
            message: 'User-controlled URL passed to fetch — validate against an allowlist to prevent SSRF',
            severity: 'warning',
            category: 'security',
            fix: 'Validate the URL against an allowlist of permitted domains before making the request',
          })
          break
        }
      }
    }

    return findings
  },
}
