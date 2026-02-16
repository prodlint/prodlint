import type { Rule, Finding, FileContext, ProjectContext } from '../types.js'
import { isApiRoute } from '../utils/patterns.js'

// Routes that typically don't need auth
const AUTH_EXEMPT_PATTERNS = [
  /auth/i,
  /login/i,
  /signup/i,
  /register/i,
  /callback/i,
  /webhook/i,
  /health/i,
  /ping/i,
  /cron/i,
  /inngest/i,
  /stripe/i,
  /public/i,
]

// Patterns that indicate auth is being checked
const AUTH_PATTERNS = [
  /getSession/,
  /getServerSession/,
  /getUser/,
  /auth\(\)/,
  /createClient.*auth/s,
  /supabase.*auth\.getUser/s,
  /session/i,
  /authenticate/i,
  /isAuthenticated/i,
  /requireAuth/i,
  /withAuth/i,
  /NextAuth/,
  /getToken/,
  /verifyToken/,
  /jwt\.verify/,
  /cookies\(\)/,
  /headers\(\)/,
  /authorization/i,
  /bearer/i,
  /createRouteHandlerClient/,
  /createServerComponentClient/,
]

export const authChecksRule: Rule = {
  id: 'auth-checks',
  name: 'Missing Auth Checks',
  description: 'Detects API routes that lack authentication checks',
  category: 'security',
  severity: 'critical',
  fileExtensions: ['ts', 'tsx', 'js', 'jsx'],

  check(file: FileContext, _project: ProjectContext): Finding[] {
    if (!isApiRoute(file.relativePath)) return []

    // Check if route is exempt
    for (const pattern of AUTH_EXEMPT_PATTERNS) {
      if (pattern.test(file.relativePath)) return []
    }

    // Check if any auth pattern exists in the file
    for (const pattern of AUTH_PATTERNS) {
      if (pattern.test(file.content)) return []
    }

    // Find the line where the handler is exported
    let handlerLine = 1
    for (let i = 0; i < file.lines.length; i++) {
      if (/export\s+(async\s+)?function\s+(GET|POST|PUT|PATCH|DELETE|handler)/i.test(file.lines[i])) {
        handlerLine = i + 1
        break
      }
    }

    return [{
      ruleId: 'auth-checks',
      file: file.relativePath,
      line: handlerLine,
      column: 1,
      message: 'API route has no authentication check',
      severity: 'critical',
      category: 'security',
    }]
  },
}
