import type { Rule, Finding, FileContext, ProjectContext } from '../types.js'
import { isTestFile } from '../utils/patterns.js'

const USE_SERVER = /['"]use server['"]/

const AUTH_PATTERNS = [
  /getServerSession\s*\(/,
  /getSession\s*\(/,
  /\.auth\.getUser\s*\(/,
  /auth\(\)/,
  /authenticate\s*\(/,
  /isAuthenticated/,
  /requireAuth/,
  /withAuth/,
  /getToken\s*\(/,
  /verifyToken\s*\(/,
  /jwt\.verify\s*\(/,
  /createServerComponentClient/,
  /currentUser\s*\(/,
  /getAuth\s*\(/,
  /cookies\(\).*auth/s,
  /session/i,
]

// Server actions that are clearly public (no auth needed)
const PUBLIC_ACTION_NAMES = [
  /contact/i,
  /subscribe/i,
  /newsletter/i,
  /feedback/i,
  /signup/i,
  /login/i,
  /register/i,
]

export const serverActionAuthRule: Rule = {
  id: 'server-action-auth',
  name: 'Server Action Without Auth',
  description: 'Detects server actions that perform mutations without any authentication check',
  category: 'security',
  severity: 'warning',
  fileExtensions: ['ts', 'tsx', 'js', 'jsx'],

  check(file: FileContext, project: ProjectContext): Finding[] {
    if (isTestFile(file.relativePath)) return []
    if (!USE_SERVER.test(file.content)) return []
    if (project.hasAuthMiddleware) return []

    // Check if path suggests public actions
    for (const p of PUBLIC_ACTION_NAMES) {
      if (p.test(file.relativePath)) return []
    }

    // Check for any auth pattern
    const hasAuth = AUTH_PATTERNS.some(p => p.test(file.content))
    if (hasAuth) return []

    // Check for mutations (if it's just a read action, lower concern)
    const hasMutation = /\.(insert|update|delete|create|upsert|remove|destroy|save|push|set)\s*\(/i.test(file.content) ||
      /\b(INSERT|UPDATE|DELETE)\b/.test(file.content)

    if (!hasMutation) return []

    let reportLine = 1
    for (let i = 0; i < file.lines.length; i++) {
      if (USE_SERVER.test(file.lines[i])) {
        reportLine = i + 1
        break
      }
    }

    return [{
      ruleId: 'server-action-auth',
      file: file.relativePath,
      line: reportLine,
      column: 1,
      message: 'Server action performs mutations without any authentication check — anyone can call this action',
      severity: 'warning',
      category: 'security',
      fix: 'Add auth check: const session = await auth(); if (!session) throw new Error("Unauthorized")',
    }]
  },
}
