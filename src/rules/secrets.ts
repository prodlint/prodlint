import type { Rule, Finding, FileContext, ProjectContext } from '../types.js'
import { isCommentLine } from '../utils/patterns.js'

const SECRET_PATTERNS: { name: string; pattern: RegExp }[] = [
  { name: 'Stripe secret key', pattern: /sk_live_[a-zA-Z0-9]{20,}/ },
  { name: 'Stripe test key', pattern: /sk_test_[a-zA-Z0-9]{20,}/ },
  { name: 'AWS access key', pattern: /AKIA[0-9A-Z]{16}/ },
  { name: 'AWS secret key', pattern: /(?:aws_secret_access_key|AWS_SECRET)\s*[=:]\s*['"]?[A-Za-z0-9/+=]{40}['"]?/ },
  { name: 'Supabase service role key', pattern: /eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9\.[A-Za-z0-9_-]{50,}\.[A-Za-z0-9_-]{20,}/ },
  { name: 'OpenAI API key', pattern: /sk-[a-zA-Z0-9]{20,}T3BlbkFJ[a-zA-Z0-9]{20,}/ },
  { name: 'GitHub token', pattern: /gh[ps]_[A-Za-z0-9_]{36,}/ },
  { name: 'GitHub fine-grained token', pattern: /github_pat_[A-Za-z0-9_]{22,}/ },
  { name: 'Generic API key assignment', pattern: /(?:api_key|apikey|api_secret|secret_key|private_key)\s*[=:]\s*['"][a-zA-Z0-9_\-]{20,}['"]/ },
  { name: 'SendGrid API key', pattern: /SG\.[a-zA-Z0-9_-]{22}\.[a-zA-Z0-9_-]{43}/ },
]

export const secretsRule: Rule = {
  id: 'secrets',
  name: 'Hardcoded Secrets',
  description: 'Detects hardcoded API keys, tokens, and credentials in source code',
  category: 'security',
  severity: 'critical',
  fileExtensions: ['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'json'],

  check(file: FileContext, _project: ProjectContext): Finding[] {
    const findings: Finding[] = []

    for (let i = 0; i < file.lines.length; i++) {
      const line = file.lines[i]

      // Skip comments (single-line and block)
      if (isCommentLine(file.lines, i, file.commentMap)) continue

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
