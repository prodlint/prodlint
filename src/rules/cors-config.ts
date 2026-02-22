import type { Rule, Finding, FileContext, ProjectContext } from '../types.js'
import { isCommentLine } from '../utils/patterns.js'

function hasCredentialsNearby(lines: string[], startLine: number, commentMap: boolean[]): boolean {
  const end = Math.min(lines.length, startLine + 8)
  for (let j = startLine; j < end; j++) {
    if (commentMap[j]) continue
    if (/credentials\s*:\s*true/.test(lines[j])) return true
    if (/Access-Control-Allow-Credentials['"]\s*[,:]\s*['"]true['"]/.test(lines[j])) return true
  }
  return false
}

export const corsConfigRule: Rule = {
  id: 'cors-config',
  name: 'Permissive CORS',
  description: 'Detects overly permissive CORS configuration',
  category: 'security',
  severity: 'warning',
  fileExtensions: ['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs'],

  check(file: FileContext, _project: ProjectContext): Finding[] {
    const findings: Finding[] = []

    for (let i = 0; i < file.lines.length; i++) {
      if (isCommentLine(file.lines, i, file.commentMap)) continue

      const line = file.lines[i]

      if (/['"]Access-Control-Allow-Origin['"]\s*[,:]\s*['"]\*['"]/.test(line)) {
        const withCreds = hasCredentialsNearby(file.lines, i, file.commentMap)
        findings.push({
          ruleId: 'cors-config',
          file: file.relativePath,
          line: i + 1,
          column: line.indexOf('Access-Control') + 1,
          message: withCreds
            ? 'CORS wildcard with credentials allows any site to make authenticated requests'
            : 'Access-Control-Allow-Origin set to "*" allows any domain',
          severity: withCreds ? 'critical' : 'warning',
          category: 'security',
          fix: withCreds
            ? 'Never use credentials with wildcard origin. Set origin to specific trusted domains.'
            : "Restrict origin to specific domains: origin: ['https://yourdomain.com']",
        })
      }

      if (/cors\(\s*\)/.test(line)) {
        findings.push({
          ruleId: 'cors-config',
          file: file.relativePath,
          line: i + 1,
          column: line.indexOf('cors(') + 1,
          message: 'cors() called without config allows all origins',
          severity: 'warning',
          category: 'security',
          fix: "Pass explicit options: cors({ origin: 'https://yourdomain.com' })",
        })
      }

      if (/origin\s*:\s*['"]\*['"]/.test(line)) {
        const withCreds = hasCredentialsNearby(file.lines, i, file.commentMap)
        findings.push({
          ruleId: 'cors-config',
          file: file.relativePath,
          line: i + 1,
          column: line.indexOf('origin') + 1,
          message: withCreds
            ? 'CORS wildcard with credentials allows any site to make authenticated requests'
            : 'CORS origin set to "*" allows any domain',
          severity: withCreds ? 'critical' : 'warning',
          category: 'security',
          fix: withCreds
            ? 'Never use credentials with wildcard origin. Set origin to specific trusted domains.'
            : "Restrict origin to specific domains: origin: ['https://yourdomain.com']",
        })
      }

      if (/origin\s*:\s*true/.test(line)) {
        findings.push({
          ruleId: 'cors-config',
          file: file.relativePath,
          line: i + 1,
          column: line.indexOf('origin') + 1,
          message: 'CORS origin set to true mirrors any requesting origin',
          severity: 'warning',
          category: 'security',
          fix: 'Set origin to specific domains instead of reflecting the request origin',
        })
      }
    }

    return findings
  },
}
