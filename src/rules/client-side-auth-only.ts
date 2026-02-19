import type { Rule, Finding, FileContext, ProjectContext } from '../types.js'
import { isClientComponent, isTestFile } from '../utils/patterns.js'

const CLIENT_AUTH_PATTERNS = [
  /localStorage\.(?:get|set)Item\s*\(\s*['"`](?:token|auth|session|jwt|access_token|user)['"`]/,
  /sessionStorage\.(?:get|set)Item\s*\(\s*['"`](?:token|auth|session|jwt|access_token|user)['"`]/,
]

const PASSWORD_CHECK = /(?:password|passwd)\s*[!=]==?\s*['"`]/

export const clientSideAuthOnlyRule: Rule = {
  id: 'client-side-auth-only',
  name: 'Client-Side Auth Only',
  description: 'Detects authentication logic implemented only in client-side code — easily bypassed via browser DevTools',
  category: 'security',
  severity: 'critical',
  fileExtensions: ['tsx', 'jsx', 'ts', 'js'],

  check(file: FileContext, _project: ProjectContext): Finding[] {
    if (isTestFile(file.relativePath)) return []
    if (!isClientComponent(file.content)) return []

    const findings: Finding[] = []

    // Check for password comparisons in client code
    for (let i = 0; i < file.lines.length; i++) {
      const line = file.lines[i]
      const match = PASSWORD_CHECK.exec(line)
      if (match) {
        findings.push({
          ruleId: 'client-side-auth-only',
          file: file.relativePath,
          line: i + 1,
          column: match.index + 1,
          message: 'Password comparison in client-side code — the password is visible in the JavaScript bundle',
          severity: 'critical',
          category: 'security',
          fix: 'Move authentication logic to a server action or API route',
        })
      }
    }

    // Check for auth token management in localStorage
    for (let i = 0; i < file.lines.length; i++) {
      const line = file.lines[i]
      for (const pattern of CLIENT_AUTH_PATTERNS) {
        const match = pattern.exec(line)
        if (match) {
          findings.push({
            ruleId: 'client-side-auth-only',
            file: file.relativePath,
            line: i + 1,
            column: match.index + 1,
            message: 'Auth token in localStorage — accessible to any script on the page (XSS risk). Use httpOnly cookies instead.',
            severity: 'warning',
            category: 'security',
            fix: 'Store auth tokens in httpOnly cookies set by the server, not in localStorage',
          })
          break
        }
      }
    }

    return findings
  },
}
