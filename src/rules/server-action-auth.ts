import type { Rule, Finding, FileContext, ProjectContext } from '../types.js'
import type { MemberExpression, Node, Program } from '@babel/types'
import { unwrapExpression } from '../utils/ast.js'
import { isTestFile, nameWords, saysAuth, saysNoAuth } from '../utils/patterns.js'

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

// An action built on an auth-checking client counts as checked. With next-safe-action the
// check runs in the client's .use() middleware, usually in another file, so the client's name
// is what's left to read: authActionClient.inputSchema(schema).action(fn). As in auth-checks,
// a name says it with an auth or session word. "protected" says it too, and so does a client
// named for who may call it, by its whole name: userActionClient, adminAction. "user" and
// "admin" alone don't: updateUser and logAdminAction aren't clients, and withSupabaseAdmin and
// adminClient are about a service-role client.
const PROTECTED_WORD = /^protected$/i
const ROLE_CLIENT = /^(?:user|(?:super|platform|system)?admin)(?:Action|ActionClient)$/i

function saysChecked(name: string): boolean {
  const words = nameWords(name)
  // A condition isn't a check: throwIfAuthenticated turns signed-in users away, for actions
  // like sending a sign-up code, and authIfPresent lets anyone in. throwIfNotAuthenticated checks.
  if (words.some((word, i) => /^if$/i.test(word) && !/^not$/i.test(words[i + 1] ?? ''))) return false
  if (saysNoAuth(name)) return false
  return saysAuth(name) || words.some(word => PROTECTED_WORD.test(word)) || ROLE_CLIENT.test(name)
}

interface Client {
  checked: boolean // a name in its chain says it checks, or a .use() does
  middleware: boolean // it has a .use(), which a name that says auth can be about
}

const propertyName = (node: MemberExpression): string =>
  !node.computed && node.property.type === 'Identifier' ? node.property.name : ''

// Sorts what a 'use server' file exports: the actions built on an auth-checking client, and
// how many other exports there are. Only the callee chain counts: an argument like
// inputSchema(authSchema), or an action's own name, says nothing about a check.
function readExports(program: Program): { checked: Node[]; others: number } {
  const imported = new Map<string, string>() // local name → the name it was exported under
  const defined = new Map<string, Node>() // const client = …, but not functions: only a name to go on there
  for (const st of program.body) {
    if (st.type === 'ImportDeclaration') {
      for (const s of st.specifiers) {
        if (s.type === 'ImportSpecifier') imported.set(s.local.name, s.imported.type === 'Identifier' ? s.imported.name : s.imported.value)
      }
      continue
    }
    const decl = st.type === 'ExportNamedDeclaration' ? st.declaration : st
    if (decl?.type !== 'VariableDeclaration') continue
    for (const d of decl.declarations) {
      if (d.id.type !== 'Identifier' || !d.init) continue
      const value = unwrapExpression(d.init)
      if (value.type !== 'ArrowFunctionExpression' && value.type !== 'FunctionExpression') defined.set(d.id.name, d.init)
    }
  }

  // Walks a chain from its root: authActionClient, .inputSchema(s), .action(fn)
  const read = (expression: Node, seen: Set<string>): Client => {
    const node = unwrapExpression(expression)
    if (node.type === 'CallExpression') {
      const callee = unwrapExpression(node.callee)
      const client = read(callee, seen)
      if (callee.type !== 'MemberExpression' || propertyName(callee) !== 'use') return client
      // A check added here counts whatever it's added to
      return { checked: client.checked || node.arguments.some(arg => read(arg, seen).checked), middleware: true }
    }
    if (node.type === 'MemberExpression') {
      const client = read(node.object, seen)
      const name = propertyName(node)
      return { ...client, checked: !saysNoAuth(name) && (client.checked || saysChecked(name)) }
    }
    if (node.type === 'Identifier') {
      // A renamed import keeps its real name: actionClient as authActionClient is still plain
      const name = imported.get(node.name) ?? node.name
      const definition = seen.has(node.name) ? undefined : defined.get(node.name)
      if (!definition) return { checked: saysChecked(name), middleware: false }
      // Defined here, so the definition shows what it's built with. createSafeActionClient()
      // alone checks nothing, whatever it's called; with a .use(), the name can be about that.
      const client = read(definition, new Set(seen).add(node.name))
      return { ...client, checked: !saysNoAuth(name) && (client.checked || (client.middleware && saysChecked(name))) }
    }
    return { checked: false, middleware: false }
  }

  // What an export points at: export { deleteItem } → the value of const deleteItem
  const valueOf = (node: Node): Node => {
    const seen = new Set<string>()
    let value = unwrapExpression(node)
    while (value.type === 'Identifier' && !seen.has(value.name)) {
      seen.add(value.name)
      const definition = defined.get(value.name)
      if (!definition) break
      value = unwrapExpression(definition)
    }
    return value
  }

  const checked: Node[] = []
  let others = 0
  const add = (exported: Node | null | undefined) => {
    const value = exported && valueOf(exported)
    if (value?.type === 'CallExpression' && read(value, new Set()).checked) checked.push(value)
    else others++
  }
  for (const st of program.body) {
    if (st.type === 'ExportDefaultDeclaration') {
      add(st.declaration)
    } else if (st.type === 'ExportAllDeclaration') {
      if (st.exportKind !== 'type') others++
    } else if (st.type === 'ExportNamedDeclaration' && st.exportKind !== 'type') {
      if (st.declaration?.type === 'VariableDeclaration') {
        for (const d of st.declaration.declarations) add(d.init)
      } else if (st.declaration) {
        others++ // export async function deleteItem() {…}
      } else {
        for (const s of st.specifiers) {
          if (s.type === 'ExportSpecifier' && s.exportKind === 'type') continue
          // export { deleteItem }; with `from`, its code is out of sight
          if (s.type === 'ExportSpecifier' && !st.source) add(s.local)
          else others++
        }
      }
    }
  }
  return { checked, others }
}

// The source with these nodes' code blanked out, keeping offsets
function blankNodes(content: string, nodes: Node[]): string {
  let code = content
  for (const { start, end } of nodes) {
    if (typeof start === 'number' && typeof end === 'number') {
      code = code.slice(0, start) + ' '.repeat(end - start) + code.slice(end)
    }
  }
  return code
}

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

    // Actions built on an auth-checking client are covered. Next to other exports, their code
    // doesn't count as a mutation; a file Babel can't parse is only read as text.
    const { checked, others } = file.ast ? readExports(file.ast.program) : { checked: [], others: 0 }
    if (checked.length > 0 && others === 0) return []
    const code = blankNodes(file.content, checked)

    // Check for mutations (if it's just a read action, lower concern)
    const hasMutation = /\.(insert|update|delete|create|upsert|remove|destroy|save|push|set)\s*\(/i.test(code) ||
      /\b(INSERT|UPDATE|DELETE)\b/.test(code)

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
    // treat server actions like public API endpoints that check the user themselves. A
    // matcher that keeps the middleware on /api means it never runs on those POSTs.
    const middlewareSkipsPages = project.hasAuthMiddleware && project.authMiddlewareExcludesPages === true
    const middleware = project.hasAuthMiddleware && !middlewareSkipsPages

    return [{
      ruleId: 'server-action-auth',
      file: file.relativePath,
      line: reportLine,
      column: 1,
      message: middleware
        ? 'Server action performs mutations without an inline auth check (middleware auth detected — verify coverage)'
        : middlewareSkipsPages
          ? "Server action performs mutations without any authentication check (middleware auth detected, but its matcher doesn't cover pages)"
          : 'Server action performs mutations without any authentication check — anyone can call this action',
      severity: middleware ? 'info' : 'warning',
      category: 'security',
      fix: middleware
        ? 'Check the user in the action too, not only in middleware: const session = await auth(); if (!session) throw new Error("Unauthorized")'
        : 'Add auth check: const session = await auth(); if (!session) throw new Error("Unauthorized")',
    }]
  },
}
