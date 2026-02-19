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
  /getServerSession\s*\(/,
  /getSession\s*\(/,
  /\.auth\.getUser\s*\(/,
  /auth\(\)/,
  /authenticate\s*\(/,
  /isAuthenticated/,
  /requireAuth/,
  /withAuth/,
  /NextAuth/,
  /getToken\s*\(/,
  /verifyToken\s*\(/,
  /jwt\.verify\s*\(/,
  /createRouteHandlerClient/,
  /createServerComponentClient/,
  /createMiddlewareClient/,
  /authorization/i,
  /getAuth\s*\(/,
  /withPageAuth/,
  /cookies\(\).*auth/s,
]

// HTTP methods that indicate mutations (higher risk without auth)
const MUTATION_EXPORT = /export\s+(?:async\s+)?function\s+(POST|PUT|PATCH|DELETE)\b/

export const authChecksRule: Rule = {
  id: 'auth-checks',
  name: 'Missing Auth Checks',
  description: 'Detects API routes that lack authentication checks',
  category: 'security',
  severity: 'warning',
  fileExtensions: ['ts', 'tsx', 'js', 'jsx'],

  check(file: FileContext, project: ProjectContext): Finding[] {
    if (!isApiRoute(file.relativePath)) return []

    // Check if route is exempt
    for (const pattern of AUTH_EXEMPT_PATTERNS) {
      if (pattern.test(file.relativePath)) return []
    }

    // Check if any auth pattern exists in the file
    for (const pattern of AUTH_PATTERNS) {
      if (pattern.test(file.content)) return []
    }

    // Determine severity based on context
    let severity: 'critical' | 'warning' | 'info'
    if (project.hasAuthMiddleware) {
      // Middleware handles auth — just an informational note
      severity = 'info'
    } else if (MUTATION_EXPORT.test(file.content)) {
      // Mutation route without any auth middleware — high confidence risk
      severity = 'critical'
    } else {
      // Read-only GET routes without auth are common (public APIs)
      severity = 'info'
    }

    // Find the line where the handler is exported
    let handlerLine = 1
    for (let i = 0; i < file.lines.length; i++) {
      if (/export\s+(async\s+)?function\s+(GET|POST|PUT|PATCH|DELETE|handler)/i.test(file.lines[i])) {
        handlerLine = i + 1
        break
      }
    }

    const message = project.hasAuthMiddleware
      ? 'API route has no inline auth check (middleware auth detected — verify coverage)'
      : 'API route has no authentication check'

    return [{
      ruleId: 'auth-checks',
      file: file.relativePath,
      line: handlerLine,
      column: 1,
      message,
      severity,
      category: 'security',
    }]
  },
}
