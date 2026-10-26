import type { Rule, Finding, FileContext, ProjectContext } from '../types.js'
import { isCommentLine } from '../utils/patterns.js'

/**
 * What an HS256 JWT is, from its `role` claim. Supabase's legacy API keys are such JWTs:
 * the service_role key bypasses RLS, while the anon key is public by design (it ships to
 * the browser, and RLS guards the data), so it isn't a secret. Anything else is a bearer
 * token like any other.
 */
function nameJwt(token: string): string | null {
  try {
    const claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'))
    if (claims?.role === 'anon') return null
    if (claims?.role === 'service_role') return 'Supabase service role key'
  } catch {
    // Payload isn't JSON: still a JWT-shaped token
  }
  return 'JWT'
}

const SECRET_PATTERNS: {
  name: string
  pattern: RegExp
  /** The name to report for this match, or null when it isn't a secret after all */
  nameMatch?: (match: string) => string | null
}[] = [
  { name: 'Stripe secret key', pattern: /sk_live_[a-zA-Z0-9]{8,}/ },
  { name: 'Stripe test key', pattern: /sk_test_[a-zA-Z0-9]{8,}/ },
  { name: 'AWS access key', pattern: /AKIA[0-9A-Z]{16}/ },
  { name: 'AWS secret key', pattern: /(?:aws_secret_access_key|AWS_SECRET)\s*[=:]\s*['"]?[A-Za-z0-9/+=]{40}['"]?/ },
  { name: 'JWT', pattern: /eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9\.[A-Za-z0-9_-]{50,}\.[A-Za-z0-9_-]{20,}/, nameMatch: nameJwt },
  { name: 'OpenAI API key (legacy)', pattern: /sk-[a-zA-Z0-9]{20,}T3BlbkFJ[a-zA-Z0-9]{20,}/ },
  { name: 'OpenAI API key', pattern: /sk-proj-[a-zA-Z0-9_\-]{20,}/ },
  { name: 'Anthropic API key', pattern: /sk-ant-(?:api|admin)[0-9]{2}-[a-zA-Z0-9_\-]{20,}/ },
  { name: 'GitHub token', pattern: /gh[ps]_[A-Za-z0-9_]{36,}/ },
  { name: 'GitHub fine-grained token', pattern: /github_pat_[A-Za-z0-9_]{22,}/ },
  { name: 'Generic API key assignment', pattern: /(?:api_key|apikey|api_secret|secret_key|private_key)\s*[=:]\s*['"][a-zA-Z0-9_\-]{20,}['"]/ },
  { name: 'SendGrid API key', pattern: /SG\.[a-zA-Z0-9_-]{22}\.[a-zA-Z0-9_-]{43}/ },
  // Cloud / platform keys
  { name: 'Google API key', pattern: /AIza[0-9A-Za-z_\-]{35}/ },
  { name: 'Google OAuth client secret', pattern: /GOCSPX-[a-zA-Z0-9_\-]{20,}/ },
  { name: 'GitLab personal access token', pattern: /glpat-[A-Za-z0-9_\-]{20,}/ },
  { name: 'npm access token', pattern: /npm_[A-Za-z0-9]{36}/ },
  { name: 'Slack token', pattern: /xox[baprs]-[A-Za-z0-9-]{10,}/ },
  { name: 'Slack webhook URL', pattern: /hooks\.slack\.com\/services\/[A-Za-z0-9_\-\/]{20,}/ },
  { name: 'Supabase secret key', pattern: /sb_secret_[a-zA-Z0-9_\-]{20,}/ },
  // AI provider keys
  { name: 'Hugging Face token', pattern: /hf_[a-zA-Z0-9]{34,}/ },
  { name: 'Groq API key', pattern: /gsk_[a-zA-Z0-9]{40,}/ },
  // Structural / high-signal
  { name: 'private key', pattern: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/ },
  { name: 'database connection string with credentials', pattern: /(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqps?):\/\/[^\s:@/]+:[^\s@/]{3,}@/ },
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

      for (const { name, pattern, nameMatch } of SECRET_PATTERNS) {
        const match = pattern.exec(line)
        if (match) {
          const reported = nameMatch ? nameMatch(match[0]) : name
          if (!reported) continue
          findings.push({
            ruleId: 'secrets',
            file: file.relativePath,
            line: i + 1,
            column: match.index + 1,
            message: `Hardcoded ${reported} detected`,
            severity: 'critical',
            category: 'security',
            fix: 'Move the secret to an environment variable and access via process.env.SECRET_NAME',
          })
        }
      }
    }

    return findings
  },
}
