import type { Rule, Finding, FileContext, ProjectContext } from '../types.js'
import { isTestFile } from '../utils/patterns.js'

// The directive starts a line (file top or function body); "use server" inside a string,
// like an error message in React's compiled server bundles, doesn't make a server action
const USE_SERVER = /^\s*['"]use server['"]/m

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
  // Session lookups, not just any "session" text (a `sessionId` form field isn't auth):
  // verifySession(), getIronSession(), lucia.validateSession(), getServerAuthSession()...
  /\w*session\w*\s*\(/i,
  // ...reading a session cookie, or using and guarding a session object
  /cookie\w*\(?\)?\)?\s*\.get\(\s*['"`][\w-]*(?:session|auth|token)/i,
  /\bsession\??\.user(?:Id)?\b/,
  /!\s*session\b/,
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

    // Auth middleware lowers the severity but doesn't clear the finding. An action is a POST
    // to a page path, and middleware lets public pages through (clerkMiddleware() makes none
    // private by default). Next.js's auth guide says not to rely on middleware alone, and to
    // treat server actions like public API endpoints that check the user themselves.
    const middleware = project.hasAuthMiddleware

    return [{
      ruleId: 'server-action-auth',
      file: file.relativePath,
      line: reportLine,
      column: 1,
      message: middleware
        ? 'Server action performs mutations without an inline auth check (middleware auth detected — verify coverage)'
        : 'Server action performs mutations without any authentication check — anyone can call this action',
      severity: middleware ? 'info' : 'warning',
      category: 'security',
      fix: middleware
        ? 'Check the user in the action too, not only in middleware: const session = await auth(); if (!session) throw new Error("Unauthorized")'
        : 'Add auth check: const session = await auth(); if (!session) throw new Error("Unauthorized")',
    }]
  },
}
