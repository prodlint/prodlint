import type { Rule, Finding, FileContext, ProjectContext } from '../types.js'

const SECRET_PATTERNS: { name: string; pattern: RegExp }[] = [
  // Stripe
  { name: 'Stripe secret key', pattern: /sk_live_[a-zA-Z0-9]{20,}/ },
  { name: 'Stripe test key', pattern: /sk_test_[a-zA-Z0-9]{20,}/ },
  // AWS
  { name: 'AWS access key', pattern: /AKIA[0-9A-Z]{16}/ },
  { name: 'AWS secret key', pattern: /(?:aws_secret_access_key|AWS_SECRET)\s*[=:]\s*['"]?[A-Za-z0-9/+=]{40}['"]?/ },
  // Supabase
  { name: 'Supabase service role key', pattern: /eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9\.[A-Za-z0-9_-]{50,}\.[A-Za-z0-9_-]{20,}/ },
  // OpenAI
  { name: 'OpenAI API key', pattern: /sk-[a-zA-Z0-9]{20,}T3BlbkFJ[a-zA-Z0-9]{20,}/ },
  // GitHub
  { name: 'GitHub token', pattern: /gh[ps]_[A-Za-z0-9_]{36,}/ },
  { name: 'GitHub fine-grained token', pattern: /github_pat_[A-Za-z0-9_]{22,}/ },
  // Generic high-entropy
  { name: 'Generic API key assignment', pattern: /(?:api_key|apikey|api_secret|secret_key|private_key)\s*[=:]\s*['"][a-zA-Z0-9_\-]{20,}['"]/ },
  // SendGrid
  { name: 'SendGrid API key', pattern: /SG\.[a-zA-Z0-9_-]{22}\.[a-zA-Z0-9_-]{43}/ },
  // Twilio
  { name: 'Twilio auth token', pattern: /SK[a-f0-9]{32}/ },
]

// Files that are expected to have secrets/tokens
const SKIP_FILES = /\.(env|env\.example|env\.local|env\.sample)$/

export const secretsRule: Rule = {
  id: 'secrets',
  name: 'Hardcoded Secrets',
  description: 'Detects hardcoded API keys, tokens, and credentials in source code',
  category: 'security',
  severity: 'critical',
  fileExtensions: ['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'json'],

  check(file: FileContext, _project: ProjectContext): Finding[] {
    // Don't flag .env files — those should be gitignored, handled by env-exposure rule
    if (SKIP_FILES.test(file.relativePath)) return []

    const findings: Finding[] = []

    for (let i = 0; i < file.lines.length; i++) {
      const line = file.lines[i]

      // Skip comments
      const trimmed = line.trim()
      if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) continue

      for (const { name, pattern } of SECRET_PATTERNS) {
        const match = pattern.exec(line)
        if (match) {
          findings.push({
            ruleId: 'secrets',
            file: file.relativePath,
            line: i + 1,
            column: match.index + 1,
            message: `Hardcoded ${name} detected`,
            severity: 'critical',
            category: 'security',
          })
        }
      }
    }

    return findings
  },
}
