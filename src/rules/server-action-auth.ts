import type { Rule, Finding, FileContext, ProjectContext } from '../types.js'
import type { CallExpression, ImportSpecifier, MemberExpression, Node, OptionalCallExpression, OptionalMemberExpression, Program } from '@babel/types'
import { subtreeContains, unwrapExpression, walkAST } from '../utils/ast.js'
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

// A .use() that turns signed-in users away: the action is for people with no session, like sending
// a sign-up code, so it's public by design. There's no user to check, and the fix would lock out
// the only people who can call it. By its whole name: throwIfAuthenticatedApiError is about
// something else, and throwIfSession could be about one that expired.
const GUEST_ONLY = /^(?:throw|redirect)If(?:User|Already)?(?:Authenticated|LoggedIn|SignedIn)$/

interface Client {
  checked: boolean // a name in its chain says it checks, or a .use() does
  middleware: boolean // it has a .use(), which a name that says auth can be about
  guestOnly?: boolean // a .use() turns signed-in users away
}

const propertyName = (node: MemberExpression | OptionalMemberExpression): string =>
  !node.computed && node.property.type === 'Identifier' ? node.property.name : ''

const exportedName = (s: ImportSpecifier): string => s.imported.type === 'Identifier' ? s.imported.name : s.imported.value

// local name → the name it was exported under
function importedNames(program: Program): Map<string, string> {
  const imported = new Map<string, string>()
  for (const st of program.body) {
    if (st.type !== 'ImportDeclaration') continue
    for (const s of st.specifiers) {
      if (s.type === 'ImportSpecifier') imported.set(s.local.name, exportedName(s))
    }
  }
  return imported
}

// Sorts what a 'use server' file exports: the actions built on an auth-checking client or a guest
// guard, and how many other exports there are. Only the callee chain counts: an argument like
// inputSchema(authSchema), or an action's own name, says nothing about a check.
function readExports(program: Program): { checked: Node[]; others: number } {
  const imported = importedNames(program)
  const defined = new Map<string, Node>() // const client = …, but not functions: only a name to go on there
  for (const st of program.body) {
    if (st.type === 'ImportDeclaration') continue
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
      return {
        checked: client.checked || node.arguments.some(arg => read(arg, seen).checked),
        middleware: true,
        guestOnly: client.guestOnly || node.arguments.some(arg => {
          const name = lastName(arg)
          return GUEST_ONLY.test(imported.get(name) ?? name)
        }),
      }
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
    const client = value?.type === 'CallExpression' ? read(value, new Set()) : undefined
    if (value && (client?.checked || client?.guestOnly)) checked.push(value)
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
function blankNodes(content: string, nodes: { start?: number | null; end?: number | null }[]): string {
  let code = content
  for (const { start, end } of nodes) {
    if (typeof start === 'number' && typeof end === 'number') {
      code = code.slice(0, start) + ' '.repeat(end - start) + code.slice(end)
    }
  }
  return code
}

// The methods a write is called by, and SQL in a string. A file Babel can't parse is read as text.
const WRITE_CALL = /\.(insert|update|delete|create|upsert|remove|destroy|save|push|set)\s*\(/i
const SQL_WORD = /\b(INSERT|UPDATE|DELETE)\b/
const WRITE_METHOD = /^(?:insert|update|delete|create|upsert|remove|destroy|save|set)$/i

// Effects outside the process that aren't read as writes on their own, because so many aren't: a
// POST can be a GraphQL read, a token exchange or a captcha check, and a file a temp file. But one
// keeps the finding the text check gave its file, since reading calls properly mustn't lose it:
// a signed POST that places an order was only ever reported for its hash's update().
const OUTWARD_METHOD = /^(?:post|put|patch)$/i // axios.post(), env.KV.put()
const OUTWARD_HTTP_METHOD = /^(?:post|put|patch|delete)$/i // fetch(url, { method: 'POST' })
const OUTWARD_CALL = /^(?:writeFile|appendFile|unlink|rm|sendMail|sendEmail)(?:Sync)?$/
const OUTWARD_COMMAND = /^(?:Put|Delete|Copy|Create|Update)\w*Command$/ // s3.send(new PutObjectCommand(params))

// A write outlives the request. These don't, whatever their methods are called: a hash, a stream
// to the browser, AI state, a collection, a request or response being built. Neither does a cookie:
// it changes only the caller's own browser, and they can send any cookie they like. It's often a
// login, a password gate or a locale switch, which an auth check would only break.
const LOCAL_CALL = /^(?:create(?:Hash|Hmac|Sign|Verify|Cipheriv|Decipheriv|StreamableValue|StreamableUI)|getMutableAIState|cookies)$/
const LOCAL_CLASS = /^(?:Map|WeakMap|Set|WeakSet|Headers|URLSearchParams|FormData|Uint8Array)$/
// A response's or a URL's, with no definition to read: res.headers.set(), url.searchParams.delete()
const LOCAL_PROPERTY = /^(?:headers|searchParams)$/
// They make no record: Object.create(null), axios.create({ baseURL })
const CREATES_NO_RECORD = /^(?:Object|[Aa]xios)$/
// A push() is an array's, unless it's on a Firebase reference or an event client:
// db.ref('items').push(item), hatchet.event.push('order:created', order)
const PUSHES_OUT = /^(?:ref|child|event)$|Ref$/

// A model call spends the app's credits on whatever the caller sends: the AI SDK's functions, a
// client the file makes, or the two APIs most code calls on a client from anywhere,
// openai.chat.completions.create(), which other providers copy, and anthropic.messages.create().
// Any other .create() on a client from another file reads as a write.
const AI_SDK = /^(?:ai|ai\/rsc|@ai-sdk\/rsc)$/
const AI_SDK_CALL = /^(?:experimental_)?(?:generate(?:Text|Object|Image|Speech|Video)|stream(?:Text|Object|UI)|embed(?:Many)?|transcribe|rerank)$/
const AI_CLIENT = /^(?:openai|@anthropic-ai\/sdk|@google\/generative-ai|@google\/genai|groq-sdk|@langchain\/(?:openai|anthropic|google-genai))$/
// A public action can limit that instead. The provider's own limit, rate_limit_error, is no such thing.
const RATE_LIMITED = /rate[-_]?limit(?![-_])|throttle/i

const isCall = (node: Node): node is CallExpression | OptionalCallExpression =>
  node.type === 'CallExpression' || node.type === 'OptionalCallExpression'
const isMember = (node: Node): node is MemberExpression | OptionalMemberExpression =>
  node.type === 'MemberExpression' || node.type === 'OptionalMemberExpression'

// The name a chain ends in: db.ref('items') → ref, itemsRef → itemsRef
function lastName(expression: Node): string {
  const node = unwrapExpression(expression)
  if (isCall(node)) return lastName(node.callee)
  if (isMember(node)) return propertyName(node)
  return node.type === 'Identifier' ? node.name : ''
}

function callsModelApi(call: CallExpression | OptionalCallExpression): boolean {
  const callee = unwrapExpression(call.callee)
  if (!isMember(callee) || !/^(?:create|stream|parse)$/.test(propertyName(callee))) return false
  const api = unwrapExpression(callee.object)
  if (!isMember(api)) return false
  const name = propertyName(api)
  return (name === 'completions' && lastName(api.object) === 'chat') || (name === 'messages' && /^anthropic/i.test(lastName(api.object)))
}

// Whether a node outside these passes the test
function someNode(program: Program, skip: Node[], test: (node: Node) => boolean): boolean {
  let found = false
  walkAST(program, node => {
    if (found || !test(node)) return
    found = !skip.some(({ start, end }) => node.start! >= start! && node.end! <= end!)
  })
  return found
}

function hasModelCall(program: Program, skip: Node[]): boolean {
  const calls = new Set<string>()
  const clients = new Set<string>()
  for (const st of program.body) {
    if (st.type !== 'ImportDeclaration') continue
    for (const s of st.specifiers) {
      if (AI_CLIENT.test(st.source.value)) clients.add(s.local.name)
      else if (AI_SDK.test(st.source.value) && s.type === 'ImportSpecifier' && AI_SDK_CALL.test(exportedName(s))) calls.add(s.local.name)
    }
  }
  return someNode(program, skip, node => {
    if (node.type === 'NewExpression') return node.callee.type === 'Identifier' && clients.has(node.callee.name)
    return isCall(node) && (callsModelApi(node) || (node.callee.type === 'Identifier' && calls.has(node.callee.name)))
  })
}

// Whether a call in this code writes to anything that outlives the request. A name is read from
// what the file defines it as, in any scope: one that also stands for something else, or for a
// parameter or a destructured value, counts as a write, as does one defined out of sight.
function hasWriteCall(program: Program, skip: Node[]): boolean {
  const imported = importedNames(program)
  const values = new Map<string, (Node | null)[]>()
  const bind = (name: string, value: Node | null) => values.set(name, [...(values.get(name) ?? []), value])
  const bindUnknown = (pattern: Node) => walkAST(pattern, node => { if (node.type === 'Identifier') bind(node.name, null) })
  walkAST(program, node => {
    if (node.type === 'VariableDeclarator') {
      if (node.id.type !== 'Identifier') bindUnknown(node.id)
      else if (node.init) bind(node.id.name, node.init)
    } else if (node.type === 'AssignmentExpression') {
      if (node.left.type === 'Identifier') bind(node.left.name, node.right)
    } else if ('params' in node && 'body' in node) {
      node.params.forEach(bindUnknown)
    }
  })

  const isLocal = (expression: Node, seen: Set<string>): boolean => {
    const node = unwrapExpression(expression)
    if (node.type === 'NewExpression') return LOCAL_CLASS.test(lastName(node.callee))
    if (isCall(node)) {
      const callee = unwrapExpression(node.callee)
      // These return what they're called on: hash.update(a).update(b), new Map().set(a, b).set(c, d)
      if (isMember(callee) && WRITE_METHOD.test(propertyName(callee))) return isLocal(callee.object, seen)
      // A renamed import keeps its real name: { db as cookies } is still a database
      const name = callee.type === 'Identifier' ? imported.get(callee.name) ?? callee.name : lastName(callee)
      return LOCAL_CALL.test(name)
    }
    if (node.type !== 'Identifier' || seen.has(node.name)) return false
    const bound = values.get(node.name)
    return !!bound && bound.every(value => value !== null && isLocal(value, new Set(seen).add(node.name)))
  }

  const writes = (call: CallExpression | OptionalCallExpression): boolean => {
    const callee = unwrapExpression(call.callee)
    if (!isMember(callee)) return false
    const method = propertyName(callee)
    const receiver = unwrapExpression(callee.object)
    if (/^push$/i.test(method)) return PUSHES_OUT.test(lastName(receiver))
    if (!WRITE_METHOD.test(method) || callsModelApi(call)) return false
    if (/^create$/i.test(method) && receiver.type === 'Identifier' && CREATES_NO_RECORD.test(receiver.name)) return false
    // The argument tells these from a table of that name: prisma.headers.delete({ where })
    if (isMember(receiver) && LOCAL_PROPERTY.test(propertyName(receiver)) && /^(?:set|delete)$/i.test(method) && call.arguments[0]?.type !== 'ObjectExpression') return false
    return !isLocal(receiver, new Set())
  }

  return someNode(program, skip, node => isCall(node) && writes(node))
}

function hasOutwardCall(program: Program, skip: Node[]): boolean {
  return someNode(program, skip, node => {
    if (node.type === 'NewExpression') return OUTWARD_COMMAND.test(lastName(node.callee))
    if (isCall(node)) {
      const callee = unwrapExpression(node.callee)
      return OUTWARD_CALL.test(lastName(callee)) || (isMember(callee) && OUTWARD_METHOD.test(propertyName(callee)))
    }
    // Wherever the options are built, and whichever way: { method: id ? 'PUT' : 'POST' }
    return node.type === 'ObjectProperty' && lastName(node.key) === 'method' &&
      subtreeContains(node.value, value => value.type === 'StringLiteral' && OUTWARD_HTTP_METHOD.test(value.value))
  })
}

export const serverActionAuthRule: Rule = {
  id: 'server-action-auth',
  name: 'Server Action Without Auth',
  description: 'Detects server actions that perform mutations or call an AI model without any authentication check',
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

    const code = file.ast ? blankNodes(file.content, [...checked, ...(file.ast.comments ?? [])]) : file.content

    // Check for mutations (if it's just a read action, lower concern)
    const hasMutation = SQL_WORD.test(code) || (file.ast
      ? hasWriteCall(file.ast.program, checked) || (WRITE_CALL.test(code) && hasOutwardCall(file.ast.program, checked))
      : WRITE_CALL.test(code))
    const callsModel = !hasMutation && !!file.ast && hasModelCall(file.ast.program, checked) && !RATE_LIMITED.test(code)

    if (!hasMutation && !callsModel) return []
    const does = hasMutation ? 'performs mutations' : 'calls an AI model'

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
        ? `Server action ${does} without an inline auth check (middleware auth detected — verify coverage)`
        : middlewareSkipsPages
          ? `Server action ${does} without any authentication check (middleware auth detected, but its matcher doesn't cover pages)`
          : `Server action ${does} without any authentication check — anyone can call this action${hasMutation ? '' : ' and spend your credits'}`,
      severity: middleware ? 'info' : 'warning',
      category: 'security',
      fix: middleware
        ? 'Check the user in the action too, not only in middleware: const session = await auth(); if (!session) throw new Error("Unauthorized")'
        : `Add auth check: const session = await auth(); if (!session) throw new Error("Unauthorized")${hasMutation ? '' : '. If it has to stay public, rate-limit it'}`,
    }]
  },
}
