import type { Rule, Finding, FileContext, ProjectContext } from '../types.js'
import type { Node, Program } from '@babel/types'
import { isApiRoute, isCommentLine } from '../utils/patterns.js'

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
  // Reading the request's Authorization header, not sending one upstream:
  // headers.get('authorization'), req.headers.authorization, req.headers['authorization'], req.header('Authorization')
  /\.(?:get|header)\(\s*['"`]authorization['"`]/i,
  /\.headers\??\.authorization\b(?!\s*=(?!=))/i,
  /\.headers\[\s*['"`]authorization['"`]\s*\](?!\s*=(?!=))/i,
  /getAuth\s*\(/,
  /withPageAuth/,
  /cookies\(\).*auth/s,
]

// HTTP methods that indicate mutations (higher risk without auth)
const MUTATION_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

// Route handler exports that need auth. OPTIONS is left out: it answers CORS preflight,
// which browsers send without credentials.
const HANDLER_METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'])

// A tRPC route passes every request to the router, which checks auth per procedure
const TRPC_ROUTE = /['"]@trpc\/server\/adapters\//

// A handler wrapped in an auth helper counts as checked. A helper is an auth helper when
// its name has an auth or session word (auth(handler), withApiAuthRequired,
// withIronSessionApiRoute), or when it's a with* helper imported from a module whose path
// has one (dub's withWorkspace from '@/lib/auth'). "Author" isn't auth. Neither are
// "admin", "token" or "key" alone: withSupabaseAdmin hands the handler a service-role
// client, withTokenLimit counts LLM tokens, withIdempotencyKey dedupes requests.
const AUTH_WORD = /^(?:auth(?!or(?:s|ed|ing|ship)?$)|session)/i
const NO_AUTH_WORD = /^(?:without|no|non|skip|bypass|optional|public|anon|anonymous|guest)$/i

// withApiAuthRequired → with Api Auth Required; '@auth0/nextjs-auth0' → auth0 nextjs auth0
function words(name: string): string[] {
  return name.split(/[^A-Za-z0-9]+|(?<=[a-z0-9])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])/).filter(Boolean)
}

function saysAuth(name: string): boolean {
  const w = words(name)
  return w.some(x => AUTH_WORD.test(x)) && !w.some(x => NO_AUTH_WORD.test(x))
}

function isAuthHelper(name: string, source: string | undefined): boolean {
  if (words(name).some(x => NO_AUTH_WORD.test(x))) return false
  return saysAuth(name) || (/^with[A-Z0-9_$]/.test(name) && source !== undefined && saysAuth(source))
}

interface Handler {
  method: string // GET … DELETE, 'default' for a Pages Router handler, '*' for export *
  line: number
  authed: boolean // wrapped in an auth helper
  local: boolean // its code is in this file, so a missing check is visible here
}

type Verdict = Pick<Handler, 'authed' | 'local'>
const AUTHED: Verdict = { authed: true, local: true }
const LOCAL: Verdict = { authed: false, local: true }
const ELSEWHERE: Verdict = { authed: false, local: false }

function handlersFromAst(program: Program): Handler[] {
  const imports = new Map<string, string>()
  const bindings = new Map<string, Node>()
  for (const st of program.body) {
    if (st.type === 'ImportDeclaration') {
      for (const s of st.specifiers) imports.set(s.local.name, st.source.value)
      continue
    }
    const decl = st.type === 'ExportNamedDeclaration' || st.type === 'ExportDefaultDeclaration' ? st.declaration : st
    if (decl?.type === 'FunctionDeclaration' && decl.id) bindings.set(decl.id.name, decl)
    if (decl?.type === 'VariableDeclaration') {
      for (const d of decl.declarations) {
        if (d.id.type === 'Identifier' && d.init) bindings.set(d.id.name, d.init)
      }
    }
  }

  // The helper a call runs: auth(h) → auth, withMiddleware()(h) → withMiddleware, lib.withSession(h) → withSession
  const helperOf = (callee: Node): { name: string; source?: string } | null => {
    if (callee.type === 'CallExpression') return helperOf(callee.callee)
    if (callee.type === 'Identifier') return { name: callee.name, source: imports.get(callee.name) }
    if (callee.type === 'MemberExpression' && callee.property.type === 'Identifier') {
      let root: Node = callee.object
      while (root.type === 'MemberExpression') root = root.object
      return { name: callee.property.name, source: root.type === 'Identifier' ? imports.get(root.name) : undefined }
    }
    return null
  }

  const classify = (node: Node, seen: Set<string>): Verdict => {
    while (
      node.type === 'TSAsExpression' || node.type === 'TSSatisfiesExpression' || node.type === 'TSNonNullExpression' ||
      node.type === 'TSTypeAssertion' || node.type === 'ParenthesizedExpression' || node.type === 'AwaitExpression'
    ) {
      node = node.type === 'AwaitExpression' ? node.argument : node.expression
    }
    switch (node.type) {
      case 'FunctionDeclaration':
      case 'FunctionExpression':
      case 'ArrowFunctionExpression':
        return LOCAL
      case 'Identifier': {
        // export const PUT = PATCH, export { handler as GET }; an imported handler's code is elsewhere
        const bound = bindings.get(node.name)
        if (!bound || seen.has(node.name)) return ELSEWHERE
        return classify(bound, new Set(seen).add(node.name))
      }
      case 'CallExpression': {
        const helper = helperOf(node.callee)
        if (helper && isAuthHelper(helper.name, helper.source)) return AUTHED
        // Nested wrappers and the wrapped handler: withAxiom(withWorkspace(h)), defaultResponder(handler)
        let local = false
        for (const arg of node.callee.type === 'CallExpression' ? [node.callee, ...node.arguments] : node.arguments) {
          const verdict = classify(arg, seen)
          if (verdict.authed) return verdict
          local ||= verdict.local
        }
        return { authed: false, local }
      }
    }
    return ELSEWHERE
  }

  const handlers: Handler[] = []
  const add = (method: string, at: Node, verdict: Verdict) => {
    handlers.push({ method, line: at.loc?.start.line ?? 1, ...verdict })
  }
  for (const st of program.body) {
    if (st.type === 'ExportNamedDeclaration') {
      const decl = st.declaration
      if (decl?.type === 'FunctionDeclaration') {
        if (decl.id && HANDLER_METHODS.has(decl.id.name)) add(decl.id.name, st, LOCAL)
      } else if (decl?.type === 'VariableDeclaration') {
        for (const d of decl.declarations) {
          if (d.id.type === 'Identifier' && HANDLER_METHODS.has(d.id.name)) {
            add(d.id.name, d, d.init ? classify(d.init, new Set()) : ELSEWHERE)
          } else if (d.id.type === 'ObjectPattern') {
            // export const { GET, POST } = handlers: built by a library, out of sight
            for (const p of d.id.properties) {
              if (p.type === 'ObjectProperty' && p.value.type === 'Identifier' && HANDLER_METHODS.has(p.value.name)) {
                add(p.value.name, d, ELSEWHERE)
              }
            }
          }
        }
      } else if (!decl) {
        for (const s of st.specifiers) {
          if (s.type !== 'ExportSpecifier') continue
          const name = s.exported.type === 'Identifier' ? s.exported.name : s.exported.value
          if (name === 'default' || HANDLER_METHODS.has(name)) add(name, s, st.source ? ELSEWHERE : classify(s.local, new Set()))
        }
      }
    } else if (st.type === 'ExportDefaultDeclaration') {
      add('default', st, classify(st.declaration, new Set()))
    } else if (st.type === 'ExportAllDeclaration') {
      add('*', st, ELSEWHERE)
    }
  }
  return handlers
}

// Regex fallback for files Babel can't parse: the same handler forms, read from the
// export line and the few code lines after it
const METHOD = '(GET|HEAD|POST|PUT|PATCH|DELETE)'
const EXPORT_FUNCTION = new RegExp(`^\\s*export\\s+(?:async\\s+)?function\\s*\\*?\\s*${METHOD}(?![\\w$])`)
const EXPORT_CONST = new RegExp(`^\\s*export\\s+(?:const|let|var)\\s+${METHOD}(?![\\w$])\\s*(?::[^=]*)?=(?![=>])(.*)$`)
const EXPORT_DESTRUCTURED = /^\s*export\s+(?:const|let|var)\s*\{([^}]*)\}\s*=/
const EXPORT_DEFAULT = /^\s*export\s+default\s+(.*)$/
const EXPORT_ALL = /^\s*export\s*\*\s*from\b/
const EXPORT_LIST = /\bexport\s*\{([^}]*)\}(\s*from\b)?/g
const IMPORT = /\bimport\s+(?!type\b)([\w$*{}\s,]+?)\s+from\s*['"]([^'"]+)['"]/g
const INLINE_FUNCTION = /^(?:async\b|function\b|\([^)]*\)\s*(?::[^=]+)?=>|[\w$]+\s*=>)/
const CALL = /^([A-Za-z_$][\w$]*)(?:\s*\.\s*([A-Za-z_$][\w$]*))*\s*(?:<[^>()]*>)?\s*\(/
const IDENTIFIER = /^([A-Za-z_$][\w$]*)\s*(?:[,);\n]|$)/

function handlersFromText(file: FileContext): Handler[] {
  const imports = new Map<string, string>()
  for (const m of file.content.matchAll(IMPORT)) {
    for (const part of m[1].replace(/[{}]/g, ',').split(',')) {
      const spec = /^\s*(?:type\s+)?(?:\*\s+as\s+)?([\w$]+)(?:\s+as\s+([\w$]+))?\s*$/.exec(part)
      if (spec) imports.set(spec[2] ?? spec[1], m[2])
    }
  }
  const code = (i: number) => !isCommentLine(file.lines, i, file.commentMap)
  // A value that starts on line i: enough of it to see the callee chain and the first argument
  const value = (i: number, head: string) =>
    [head, ...file.lines.slice(i + 1, i + 5).filter((_, k) => code(i + 1 + k))].join('\n')

  const resolve = (name: string, seen: Set<string>): Verdict => {
    const id = name.replace(/\$/g, '\\$')
    const fn = new RegExp(`^\\s*(?:export\\s+)?(?:default\\s+)?(?:async\\s+)?function\\s*\\*?\\s*${id}(?![\\w$])`)
    const variable = new RegExp(`^\\s*(?:export\\s+)?(?:const|let|var)\\s+${id}(?![\\w$])\\s*(?::[^=]*)?=(?![=>])(.*)$`)
    for (let i = 0; i < file.lines.length; i++) {
      if (!code(i)) continue
      if (fn.test(file.lines[i])) return LOCAL
      const m = variable.exec(file.lines[i])
      if (m) return classify(value(i, m[1]), seen)
    }
    return ELSEWHERE
  }

  // `text` starts at the handler's value: async (req) => …, withWorkspace(…), handler
  const classify = (text: string, seen: Set<string>): Verdict => {
    const t = text.trim().replace(/^await\s+/, '')
    if (INLINE_FUNCTION.test(t)) return LOCAL
    const call = CALL.exec(t)
    if (call) {
      if (isAuthHelper(call[2] ?? call[1], imports.get(call[1]))) return AUTHED
      // Read the first argument; a curried call's second argument list: withMiddleware()(handler)
      let args = t.slice(call[0].length)
      const curried = /^[^()]*\)\s*\(/.exec(args)
      if (curried) args = args.slice(curried[0].length)
      return classify(args, seen)
    }
    const id = IDENTIFIER.exec(t)
    if (id && !seen.has(id[1])) return resolve(id[1], new Set(seen).add(id[1]))
    return ELSEWHERE
  }

  const handlers: Handler[] = []
  for (let i = 0; i < file.lines.length; i++) {
    if (!code(i)) continue
    const line = file.lines[i]
    let m: RegExpExecArray | null
    if ((m = EXPORT_FUNCTION.exec(line))) {
      handlers.push({ method: m[1], line: i + 1, ...LOCAL })
    } else if ((m = EXPORT_CONST.exec(line))) {
      handlers.push({ method: m[1], line: i + 1, ...classify(value(i, m[2]), new Set()) })
    } else if ((m = EXPORT_DESTRUCTURED.exec(line))) {
      for (const part of m[1].split(',')) {
        const name = part.split(':').pop()?.trim() ?? ''
        if (HANDLER_METHODS.has(name)) handlers.push({ method: name, line: i + 1, ...ELSEWHERE })
      }
    } else if ((m = EXPORT_DEFAULT.exec(line))) {
      handlers.push({ method: 'default', line: i + 1, ...classify(value(i, m[1]), new Set()) })
    } else if (EXPORT_ALL.test(line)) {
      handlers.push({ method: '*', line: i + 1, ...ELSEWHERE })
    }
  }
  const lineAt = (offset: number) => file.content.slice(0, offset).split('\n').length
  for (const m of file.content.matchAll(EXPORT_LIST)) {
    if (!code(lineAt(m.index) - 1)) continue
    let offset = m.index + m[0].indexOf('{') + 1
    for (const part of m[1].split(',')) {
      const spec = /^\s*(?:type\s+)?([\w$]+)(?:\s+as\s+([\w$]+))?\s*$/.exec(part)
      const name = spec ? spec[2] ?? spec[1] : ''
      if (spec && (name === 'default' || HANDLER_METHODS.has(name))) {
        const line = lineAt(offset + part.length - part.trimStart().length)
        handlers.push({ method: name, line, ...(m[2] ? ELSEWHERE : classify(spec[1], new Set())) })
      }
      offset += part.length + 1
    }
  }
  return handlers.sort((a, b) => a.line - b.line)
}

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

    // Handlers wrapped in an auth helper are covered; the rest are exposed
    const handlers = file.ast ? handlersFromAst(file.ast.program) : handlersFromText(file)
    const exposed = handlers.filter(h => !h.authed)
    if (handlers.length > 0 && exposed.length === 0) return []

    // Determine severity based on context
    let severity: 'critical' | 'warning' | 'info'
    if (project.hasAuthMiddleware) {
      // Middleware handles auth — just an informational note
      severity = 'info'
    } else if (exposed.some(h => h.local && MUTATION_METHODS.has(h.method)) && !TRPC_ROUTE.test(file.content)) {
      // Mutation route without any auth middleware — high confidence risk
      severity = 'critical'
    } else {
      // Read-only GET routes without auth are common (public APIs), and a handler
      // whose code is in another file (an import, a tRPC router) may check auth there
      severity = 'info'
    }

    // Report at the first exposed handler
    const handlerLine = exposed[0]?.line ?? 1

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
      fix: "Add authentication check: const session = await auth(); if (!session) return new Response('Unauthorized', { status: 401 })",
    }]
  },
}
