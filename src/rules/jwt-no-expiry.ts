import type { Rule, Finding, FileContext, ProjectContext } from '../types.js'
import { isCommentLine, isTestFile } from '../utils/patterns.js'

const JWT_SIGN = /jwt\.sign\s*\(/

const HAS_EXPIRY = [
  /expiresIn/,
  /exp\s*:/,
  /expirationTime/,
  /maxAge/,
]

export const jwtNoExpiryRule: Rule = {
  id: 'jwt-no-expiry',
  name: 'JWT Without Expiration',
  description: 'Detects jwt.sign() calls without an expiresIn option — tokens never expire, compromised tokens are valid forever',
  category: 'security',
  severity: 'warning',
  fileExtensions: ['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs'],

  check(file: FileContext, _project: ProjectContext): Finding[] {
    if (isTestFile(file.relativePath)) return []
    if (!JWT_SIGN.test(file.content)) return []

    const findings: Finding[] = []

    for (let i = 0; i < file.lines.length; i++) {
      if (isCommentLine(file.lines, i, file.commentMap)) continue
      const line = file.lines[i]

      const match = JWT_SIGN.exec(line)
      if (!match) continue

      // Check the next 5 lines for expiresIn option
      const context = file.lines.slice(i, i + 6).join('\n')
      const hasExpiry = HAS_EXPIRY.some(p => p.test(context))

      if (!hasExpiry) {
        findings.push({
          ruleId: 'jwt-no-expiry',
          file: file.relativePath,
          line: i + 1,
          column: match.index + 1,
          message: 'jwt.sign() without expiresIn — tokens never expire, a compromised token is valid forever',
          severity: 'warning',
          category: 'security',
          fix: 'Add expiration: jwt.sign(payload, secret, { expiresIn: "1h" })',
        })
      }
    }

    return findings
  },
}
