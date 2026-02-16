import type { Rule, Finding, FileContext, ProjectContext } from '../types.js'
import { isClientComponent } from '../utils/patterns.js'

// Server-only env vars that should never appear in client code
const SERVER_ENV_PATTERNS = [
  /process\.env\.(?!NEXT_PUBLIC_)([A-Z][A-Z0-9_]*)/g,
]

// Env var names that are definitely server-only sensitive
const SENSITIVE_ENV_NAMES = [
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
]

export const envExposureRule: Rule = {
  id: 'env-exposure',
  name: 'Environment Variable Exposure',
  description: 'Detects server environment variables used in client components and .env files not in .gitignore',
  category: 'security',
  severity: 'critical',
  fileExtensions: [], // Check all files

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
        })
      }
      return findings
    }

    // Check 2: Server env vars in client components
    if (!['ts', 'tsx', 'js', 'jsx'].includes(file.ext)) return findings
    if (!isClientComponent(file.content)) return findings

    for (let i = 0; i < file.lines.length; i++) {
      const line = file.lines[i]
      // Skip comments
      const trimmed = line.trim()
      if (trimmed.startsWith('//') || trimmed.startsWith('*')) continue

      for (const pattern of SERVER_ENV_PATTERNS) {
        const regex = new RegExp(pattern.source, pattern.flags)
        let match: RegExpExecArray | null
        while ((match = regex.exec(line)) !== null) {
          const envName = match[1]
          // Only flag known-sensitive or any non-NEXT_PUBLIC_ in client code
          const isSensitive = SENSITIVE_ENV_NAMES.includes(envName)
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
          })
        }
      }
    }

    return findings
  },
}
