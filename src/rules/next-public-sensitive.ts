import type { Rule, Finding, FileContext, ProjectContext } from '../types.js'
import { isCommentLine, isTestFile } from '../utils/patterns.js'

const SENSITIVE_SUFFIXES = [
  'SECRET', 'SECRET_KEY', 'PRIVATE_KEY', 'PASSWORD', 'DATABASE_URL',
  'SERVICE_ROLE_KEY', 'SERVICE_KEY', 'ADMIN_KEY', 'SIGNING_KEY',
  'ENCRYPTION_KEY', 'AUTH_SECRET', 'SESSION_SECRET',
]

const SENSITIVE_PATTERN = /NEXT_PUBLIC_\w*(SECRET|PRIVATE|PASSWORD|DATABASE_URL|SERVICE_ROLE|SERVICE_KEY|ADMIN_KEY|sk_live|sk_test|SIGNING|ENCRYPTION)/i

export const nextPublicSensitiveRule: Rule = {
  id: 'next-public-sensitive',
  name: 'Sensitive Env Var with NEXT_PUBLIC_ Prefix',
  description: 'Detects NEXT_PUBLIC_ prefix on environment variables that should be server-only — exposes secrets to the browser',
  category: 'security',
  severity: 'critical',
  fileExtensions: ['ts', 'tsx', 'js', 'jsx', 'mjs', 'env', 'env.local', 'env.production'],

  check(file: FileContext, _project: ProjectContext): Finding[] {
    if (isTestFile(file.relativePath)) return []

    const findings: Finding[] = []

    for (let i = 0; i < file.lines.length; i++) {
      if (isCommentLine(file.lines, i, file.commentMap)) continue
      const line = file.lines[i]

      const match = SENSITIVE_PATTERN.exec(line)
      if (match) {
        findings.push({
          ruleId: 'next-public-sensitive',
          file: file.relativePath,
          line: i + 1,
          column: match.index + 1,
          message: `NEXT_PUBLIC_ prefix on a sensitive env var — this value will be embedded in the client-side JavaScript bundle`,
          severity: 'critical',
          category: 'security',
          fix: 'Remove the NEXT_PUBLIC_ prefix. Access this value only in server components, API routes, or server actions.',
        })
      }
    }

    return findings
  },
}
