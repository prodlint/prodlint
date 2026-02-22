import type { Rule, Finding, FileContext, ProjectContext } from '../types.js'
import { isClientComponent, isCommentLine } from '../utils/patterns.js'

// Server-only env vars that should never appear in client code
const SERVER_ENV_PATTERN = /process\.env\.(?!NEXT_PUBLIC_)([A-Z][A-Z0-9_]*)/g

// Env var names that are definitely server-only sensitive
const SENSITIVE_ENV_NAMES = new Set([
  'DATABASE_URL',
  'SUPABASE_SERVICE_ROLE_KEY',
  'STRIPE_SECRET_KEY',
  'STRIPE_WEBHOOK_SECRET',
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'AWS_SECRET_ACCESS_KEY',
  'JWT_SECRET',
  'SESSION_SECRET',
  'REDIS_URL',
  'SMTP_PASSWORD',
  'SENDGRID_API_KEY',
])

export const envExposureRule: Rule = {
  id: 'env-exposure',
  name: 'Environment Variable Exposure',
  description: 'Detects server environment variables used in client components and .env files not in .gitignore',
  category: 'security',
  severity: 'critical',
  fileExtensions: [],

  check(file: FileContext, project: ProjectContext): Finding[] {
    const findings: Finding[] = []

    // Check 1: .env not in .gitignore
    if (file.relativePath === '.gitignore') {
      if (!project.envInGitignore) {
        findings.push({
          ruleId: 'env-exposure',
          file: file.relativePath,
          line: 1,
          column: 1,
          message: '.env is not listed in .gitignore — secrets may be committed',
          severity: 'critical',
          category: 'security',
          fix: 'Add .env to .gitignore to prevent committing secrets',
        })
      }
      return findings
    }

    // Check 2: Server env vars in client components
    if (!['ts', 'tsx', 'js', 'jsx'].includes(file.ext)) return findings
    if (!isClientComponent(file.content)) return findings

    for (let i = 0; i < file.lines.length; i++) {
      if (isCommentLine(file.lines, i, file.commentMap)) continue

      const line = file.lines[i]
      const regex = new RegExp(SERVER_ENV_PATTERN.source, SERVER_ENV_PATTERN.flags)
      let match: RegExpExecArray | null
      while ((match = regex.exec(line)) !== null) {
        const envName = match[1]
        const isSensitive = SENSITIVE_ENV_NAMES.has(envName)
        findings.push({
          ruleId: 'env-exposure',
          file: file.relativePath,
          line: i + 1,
          column: match.index + 1,
          message: isSensitive
            ? `Sensitive server env var "${envName}" used in client component`
            : `Server env var "${envName}" used in client component (will be undefined at runtime)`,
          severity: isSensitive ? 'critical' : 'warning',
          category: 'security',
          fix: 'Move to server-only file or use NEXT_PUBLIC_ prefix only for non-sensitive values',
        })
      }
    }

    return findings
  },
}
