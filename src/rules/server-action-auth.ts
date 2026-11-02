import type { Rule, Finding, FileContext, ProjectContext } from '../types.js'
import type { CallExpression, MemberExpression, Node, OptionalCallExpression, OptionalMemberExpression, Program } from '@babel/types'
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
  /cookies\(\).*auth(?!or(?!i[sz]))/s, // authorize and authorise, not authorName
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

interface Import {
  source: string
  name: string // what it was exported under; 'default' and '*' for those imports
}

function readImports(program: Program): Map<string, Import> {
  const imports = new Map<string, Import>()
  for (const st of program.body) {
    if (st.type !== 'ImportDeclaration' || st.importKind === 'type') continue
    for (const s of st.specifiers) {
      if (s.type === 'ImportSpecifier' && s.importKind === 'type') continue
      const name = s.type === 'ImportDefaultSpecifier' ? 'default' : s.type === 'ImportNamespaceSpecifier' ? '*'
        : s.imported.type === 'Identifier' ? s.imported.name : s.imported.value
      imports.set(s.local.name, { source: st.source.value, name })
    }
  }
  return imports
}

// A renamed import keeps its real name: actionClient as authActionClient is still plain.
// A default or namespace import has only the local one.
function importedName(imports: Map<string, Import>, local: string): string {
  const source = imports.get(local)
  return source && source.name !== 'default' && source.name !== '*' ? source.name : local
}

interface Exports {
  checked: Node[] // built on an auth-checking client
  guests: Node[] // behind a guard that turns signed-in users away
  open: Node[] // the code of the rest
  others: number // how many other exports there are, with code here or not
}

// Sorts what a 'use server' file exports. Only the callee chain counts: an argument like
// inputSchema(authSchema), or an action's own name, says nothing about a check.
function readExports(program: Program, imports: Map<string, Import>): Exports {
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
    if (seen.size > MAX_DEPTH) return { checked: false, middleware: false }
    const node = unwrapExpression(expression)
    if (node.type === 'CallExpression') {
      const callee = unwrapExpression(node.callee)
      const client = read(callee, seen)
      if (callee.type !== 'MemberExpression' || propertyName(callee) !== 'use') return client
      // A check added here counts whatever it's added to
      return {
        checked: client.checked || node.arguments.some(arg => read(arg, seen).checked),
        middleware: true,
        guestOnly: client.guestOnly || node.arguments.some(arg => GUEST_ONLY.test(importedName(imports, lastName(arg)))),
      }
    }
    if (node.type === 'MemberExpression') {
      const client = read(node.object, seen)
      const name = propertyName(node)
      return { ...client, checked: !saysNoAuth(name) && (client.checked || saysChecked(name)) }
    }
    if (node.type === 'Identifier') {
      const name = importedName(imports, node.name)
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
  const guests: Node[] = []
  const open: Node[] = []
  let others = 0
  const add = (exported: Node | null | undefined) => {
    const value = exported && valueOf(exported)
    const client = value?.type === 'CallExpression' ? read(value, new Set()) : undefined
    if (value && client?.checked) checked.push(value)
    else if (value && client?.guestOnly) guests.push(value)
    else {
      others++
      if (exported) open.push(exported)
    }
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
        add(st.declaration) // export async function deleteItem() {…}
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
  return { checked, guests, open, others }
}

// The source with these nodes' code blanked out, keeping offsets
function blankNodes(content: string, nodes: { start?: number | null; end?: number | null }[]): string {
  const ranges = nodes.filter(n => typeof n.start === 'number' && typeof n.end === 'number').sort((a, b) => a.start! - b.start!)
  let code = ''
  let at = 0
  for (const { start, end } of ranges) {
    if (end! <= at) continue
    const from = Math.max(start!, at)
    code += content.slice(at, from) + ' '.repeat(end! - from)
    at = end!
  }
  return code + content.slice(at)
}

// The text check this rule started as: these methods, and SQL words. A file Babel can't parse is
// read by it alone. In one it can, it finds what might be a write, and the checks below say if it is.
const WRITE_CALL = /\.(insert|update|delete|create|upsert|remove|destroy|save|push|set)\s*\(/i
const SQL_WORD = /\b(INSERT|UPDATE|DELETE)\b/

// What's a write by itself: a statement in one string, and these methods and functions, unless what
// they're called on stays local. 'UPDATE' alone could be a label, or a type, and 'SET' the next one.
const SQL_STATEMENT = /\bINSERT\b[\s\S]{0,40}?\bINTO\b|\bDELETE\b[\s\S]{0,40}?\bFROM\b|\bUPDATE\b[\s\S]{0,200}?\bSET\b/
const WRITE_METHOD = /^(?:insert|update|delete|create|upsert|remove|destroy|save|set|createMany(?:AndReturn)?|updateMany(?:AndReturn)?|deleteMany|\$executeRaw(?:Unsafe)?|insertOne|insertMany|updateOne|deleteOne|replaceOne|bulkWrite|findOneAnd(?:Update|Delete|Replace)|findByIdAnd(?:Update|Delete|Remove)|hset|hdel|sadd|srem|lpush|rpush|zadd|incr|incrby|decr|decrby|del|setex|mset)$/i
const FIRESTORE_WRITE = /^(?:setDoc|addDoc|updateDoc|deleteDoc)$/

// A write outlives the request. These don't, whatever their methods are called: a hash, a stream
// to the browser, AI state, a collection, a request or response being built. Neither does a cookie:
// it changes only the caller's own browser, and they can send any cookie they like. It's often a
// login, a password gate or a locale switch, which an auth check would only break.
const AI_SDK = /^(?:ai|ai\/rsc|@ai-sdk\/rsc)$/
const CRYPTO_CALL = /^create(?:Hash|Hmac|Sign|Verify|Cipheriv|Decipheriv)$/
const LOCAL_CALLS: [name: RegExp, source: RegExp][] = [
  [CRYPTO_CALL, /^(?:node:)?crypto$/],
  [/^cookies$/, /^next\/headers$/],
  [/^(?:createStreamable(?:Value|UI)|getMutableAIState)$/, AI_SDK],
]
const LOCAL_CLASS = /^(?:Map|WeakMap|Set|WeakSet|Headers|URLSearchParams|FormData|URL|Request|Response|(?:Big)?(?:Ui|I)nt\d+Array|Uint8ClampedArray|Float\d+Array)$/
// With no definition to read: res.headers.set(), response.cookies.delete(), url.searchParams.set()
const REQUEST_OR_RESPONSE = /^(?:res|resp|response|req|request|next|init|options|opts|config)$/i
const URL_NAME = /url|uri|href/i
// A push() is an array's, unless it's on a Firebase reference: db.ref('items').push(item)
const FIREBASE_REF = /^(?:ref|child)$/
const FIREBASE_REF_NAME = /^(?:ref|child)$|Ref$/

// At module level a collection outlives the request, and every caller sees it. One holding the app's
// data is a store. A cache is shared too, but what's in it can be fetched again, and a rate limiter's
// map is what lets the action stay public. By the whole word: memories aren't memos, and a counter of
// failed attempts or a list of banned users is what a caller would like to reset.
const MODULE_COLLECTION = /^(?:Map|Set)$/
const CACHE_WORD = /^(?:caches?|cached|memo|memoized?|lru)$/i
const LIMITER_NAME = /(?:^r|R|[-_]r)ate[-_]?[lL]imit|(?:^l|L)imiter/

// What keeps a finding. The text check above found what might be a write, and it stands unless the
// file shows it isn't: a write can be called anything (clearCart, transferFunds, guardarUsuario), so
// no list of verbs holds them all. A call that isn't shown harmless keeps it, and so does an HTTP
// method or a command that says it writes. None of that is read as a write on its own, because so
// much of it isn't: a POST can be a GraphQL read, a token exchange or a captcha check, and a name is
// only a name. This can't add a finding, only keep one, so it can afford to be broad, and a name
// missing from these lists costs what the text check always did.
const OUTWARD_HTTP_METHOD = /^(?:POST|PUT|PATCH|DELETE)$/
const OUTWARD_COMMAND = /^(?!Get|List|Describe|Head|Query|Scan)\w+Command$/ // s3.send(new PutObjectCommand(params))

// Harmless by what it's called. A question, whatever it's about: canDeleteItem. A read, by its first
// word, unless a later one says it does more: getOrCreateUser, fetchAndStore, getDeleteUrl. Not
// query(), execute() or run(), which is where raw SQL goes.
const ASKS = /^(?:is|has|can|should|exists?)$/
const READ_VERB = /^(?:get|find|fetch|list|load|read|readdir|stat|search|count|parse|format|validate|verify|check|assert|require|compute|calculate|calc|compare|build|to|from|as|map|filter|sort|sanitize|normalize|encode|decode|hash|encrypt|decrypt|serialize|deserialize|stringify|render|transform|extract|retrieve|lookup|wait|sleep|delay)$/
const WRITE_VERB = /^(?:create|update|delete|insert|upsert|remove|destroy|save|write|clear|reset|purge|wipe|drop|send|publish|enqueue|transfer|charge|pay|refund|ban|grant|revoke|increment|decrement)$/i
const DOES_MORE = /(?:Or|And|Then)(?!Throw|Null|Default|Undefined|Else|Fail)[A-Z]|^check(?:In|Out)(?:[A-Z]|$)/
// generateId() makes a value. generateSummary() and the like are often a model behind a helper.
const MAKES_A_VALUE = /^generate\w*(?:Id|Uuid|UUID|Slug|Token|Hash|Code|Otp|OTP|Signature|Secret|Nonce|Key|Salt|Password|Username|Metadata|Options|Params)$/
// A cookie changes only the caller's own browser, a factory makes a client it hasn't used yet, and a
// timer or a date is the process's own
const NOT_A_WRITE = /Cookie|^create\w*(?:Client|Middleware|Transport|Fetch|Stream|Hash|Hmac|Cipheriv|Decipheriv|Sign|Verify|Context|Instance|Schema|Logger|Error|URL|Element|Ref|Router)$|^set(?:Timeout|Interval|Immediate|Time|(?:UTC)?(?:FullYear|Month|Date|Hours|Minutes|Seconds|Milliseconds))$/
// Sign-in, sign-up and the like are public by design, and a flow an auth check can't guard
const AUTH_FLOW = /^(?:sign(?:In|Out|Up)|log(?:In|Out)|login|logout)(?:$|[A-Z])/
// The language's, the framework's and a query's own. A method of these names reads or builds, whatever it's on.
const HARMLESS_METHOD = /^(?:has|at|keys|values|entries|flatMap|reduce|reduceRight|forEach|some|every|flat|slice|concat|join|split|trim|trimStart|trimEnd|replace|replaceAll|includes|startsWith|endsWith|substring|substr|charAt|charCodeAt|indexOf|lastIndexOf|match|matchAll|test|localeCompare|padStart|padEnd|reverse|fill|pop|shift|json|text|blob|arrayBuffer|formData|clone|then|catch|finally|log|error|warn|info|debug|trace|digest|done|next|sign|bind|use|safeParse|safeParseAsync|aggregate|groupBy|select|where|having|eq|neq|gt|gte|lt|lte|like|ilike|is|in|not|or|and|contains|desc|asc|order|orderBy|limit|offset|range|single|maybeSingle|returning|leftJoin|innerJoin|rightJoin|fullJoin|doc|collection|ref|child|each|attr|first|last|children|contents|parent|action|stateAction|inputSchema|outputSchema|schema|metadata|bindArgsSchemas)$/
const CALLS_ITS_ARGUMENT = /^(?:map|flatMap|forEach|then|catch|finally)$/ // ids.map(deletePhoto)
const HARMLESS_CALL = /^(?:Number|String|Boolean|Array|Object|Date|Error|Symbol|BigInt|RegExp|Promise|parseInt|parseFloat|isNaN|isFinite|encodeURIComponent|decodeURIComponent|encodeURI|decodeURI|btoa|atob|setTimeout|clearTimeout|setInterval|clearInterval|setImmediate|structuredClone|require|redirect|permanentRedirect|notFound|revalidatePath|revalidateTag|updateTag|cookies|headers|draftMode|unstable_cache|nanoid|uuid|uuidv4|ulid|cuid|createId|customAlphabet|clsx|cn|twMerge|throttle|debounce|eq|ne|gt|gte|lt|lte|and|or|not|like|ilike|inArray|notInArray|isNull|isNotNull|between|desc|asc)$/
const HARMLESS_ROOT = /^(?:JSON|Object|Array|Math|Number|String|Date|Promise|console|Buffer|Intl|Reflect|Symbol|URL|AbortSignal|path|z|zod|yup|Joi|dayjs|moment|cheerio|\$|_|lodash|crypto|process|logger|log|Sentry)$/
const HARMLESS_SOURCE = /^(?:(?:node:)?(?:path|crypto|url|querystring)|zod|date-fns|dayjs|ms|uuid|nanoid|ulid|clsx|tailwind-merge|lodash|gray-matter|bcrypt|bcryptjs|argon2|jose|jsonwebtoken|cheerio|drizzle-orm|react|next\/(?:navigation|cache|headers|server)|ai|ai\/rsc|@ai-sdk\/[\w-]+)$/

// A model call spends the app's credits on whatever the caller sends: the AI SDK's functions, a
// client the file makes, or a .create() or the like on a client that says what it is. The SDK's
// stream and AI state don't call one: a progress bar uses them too.
const AI_SDK_CALL = /^(?:experimental_)?(?:generate(?:Text|Object|Image|Speech|Video)|stream(?:Text|Object|UI)|embed(?:Many)?|transcribe|rerank)$/
const AI_CLIENT = /^(?:openai|@anthropic-ai\/sdk|@google\/generative-ai|@google\/genai|groq-sdk|together-ai|cohere-ai|replicate|ollama|@mistralai\/mistralai|@huggingface\/inference|@aws-sdk\/client-bedrock-runtime|@langchain\/(?!core|community|langgraph|textsplitters)[\w-]+)$/
const AI_CLIENT_NAME = /^(?:open_?[aA][iI]|anthropic|groq|mistral|together|deepseek|cohere|gemini)(?:Client)?$/
const MODEL_API_METHOD = /^(?:create|stream|parse)$/

// A public action can limit that instead, and a limit is a call on its path, not a word in its file:
// OpenAI.RateLimitError is the provider's, lodash's throttle() paces a stream, "generate" ends in
// "rate", and these read a limit or react to one: logRateLimit(), retryOnRateLimit(), rateLimitKey()
const LIMIT_CALL = /(?:^r|R|[-_]r)ate[-_]?[lL]imit(?:ed|er|By\w+|For\w+)?$|^[rR]ate[-_]?[lL]imit|(?:^l|L)imiter$|^(?:slidingWindow|fixedWindow|tokenBucket)$/
const NOT_A_LIMIT = /^(?:get|set|reset|clear|log|parse|handle|format|update|retry|on|extract|show|print|report|prune)(?:[A-Z_]|$)|(?:Error|Headers?|Exceeded|Remaining|Reset|Keys?|Info|Identifier|Config|Options|Status|Response|Result)$/
// limiter(() => …) is a cap on how many run at once, as with p-limit: every caller still gets through
const CONCURRENCY_CAP = /^(?!.*[rR]ate[-_]?[lL]imiter$).*[lL]imiter$/
const LIMIT_METHOD = /^(?:limit|consume|check|take|hit|removeTokens|tryRemoveTokens|blockIfExceeded)$/
const LIMITER = /(?:^r|R|[-_]r)ate[-_]?[lL]imit|(?:^l|L)imit(?:er)?$/

// How far to follow a name or a chain. Past it, in a generated file, it's a write: the safe direction.
const MAX_DEPTH = 64

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

// The name a chain starts from: openai.chat.completions → openai
function rootName(expression: Node): string {
  let node = unwrapExpression(expression)
  while (isCall(node) || isMember(node)) node = unwrapExpression(isCall(node) ? node.callee : node.object)
  return node.type === 'Identifier' ? node.name : ''
}

const hasDirective = (directives: { value: { value: string } }[] | undefined): boolean =>
  directives?.some(d => d.value.value === 'use server') ?? false

// Code that runs when it's called, not when the file loads
const isFunction = (expression: Node | null | undefined): boolean => {
  const node = expression && unwrapExpression(expression)
  return node?.type === 'ArrowFunctionExpression' || node?.type === 'FunctionExpression' || node?.type === 'FunctionDeclaration' || node?.type === 'ClassDeclaration'
}

// A string or a template, or those put together with +, with a gap for what's computed: 'UPDATE ' + table + ' SET a = 1'
function stringText(expression: Node): string | null {
  const part = (node: Node): string | null =>
    node.type === 'StringLiteral' ? node.value : node.type === 'TemplateLiteral' ? node.quasis.map(q => q.value.raw).join(' ') : null
  let text = ''
  let node = expression
  while (node.type === 'BinaryExpression' && node.operator === '+') {
    text = `${part(node.right) ?? ' '}${text}`
    node = node.left
  }
  const first = part(node)
  return first === null && !text ? null : `${first ?? ' '}${text}`
}

// What the calls in a file do. A name is read from everything the file binds it to, in any scope:
// one that also stands for something else, or for a parameter or a destructured value, isn't known
// to be local, and neither is an import or a name defined out of sight.
function readCalls(program: Program, imports: Map<string, Import>) {
  const values = new Map<string, (Node | null)[]>()
  const typeNames = new Set<string>() // what the file imports or declares as a type too: not the global of that name
  const catches = new Set<Node>()
  const bind = (name: string, value: Node | null) => {
    const bound = values.get(name)
    if (bound) bound.push(value)
    else values.set(name, [value])
  }
  const bindPattern = (pattern: Node | null): void => {
    if (pattern?.type === 'Identifier') bind(pattern.name, null)
    else if (pattern?.type === 'ObjectPattern') pattern.properties.forEach(p => bindPattern(p.type === 'RestElement' ? p.argument : p.value))
    else if (pattern?.type === 'ArrayPattern') pattern.elements.forEach(e => bindPattern(e))
    else if (pattern?.type === 'AssignmentPattern') bindPattern(pattern.left)
    else if (pattern?.type === 'RestElement') bindPattern(pattern.argument)
    else if (pattern?.type === 'TSParameterProperty') bindPattern(pattern.parameter)
  }
  walkAST(program, node => {
    if (node.type === 'VariableDeclarator') {
      if (node.id.type !== 'Identifier') bindPattern(node.id)
      else if (node.init) bind(node.id.name, node.init)
    } else if (node.type === 'AssignmentExpression') {
      if (node.left.type === 'Identifier') bind(node.left.name, node.right)
      else bindPattern(node.left)
    } else if (node.type === 'ForOfStatement' || node.type === 'ForInStatement') {
      if (node.left.type === 'VariableDeclaration') node.left.declarations.forEach(d => bindPattern(d.id))
      else bindPattern(node.left)
    } else if (node.type === 'FunctionDeclaration' || node.type === 'ClassDeclaration') {
      if (node.id) bind(node.id.name, node)
    } else if (node.type === 'TSInterfaceDeclaration' || node.type === 'TSTypeAliasDeclaration') {
      typeNames.add(node.id.name)
    } else if (node.type === 'ImportDeclaration') {
      node.specifiers.forEach(s => typeNames.add(s.local.name))
    } else if (node.type === 'CatchClause') {
      bindPattern(node.param ?? null)
      catches.add(node)
    }
    if ('params' in node && 'body' in node) {
      for (const param of node.params) {
        // formData: FormData is what it says
        const annotation = param.type === 'Identifier' && param.typeAnnotation?.type === 'TSTypeAnnotation' ? param.typeAnnotation.typeAnnotation : null
        if (param.type === 'Identifier' && annotation?.type === 'TSTypeReference') bind(param.name, annotation)
        else bindPattern(param)
      }
    }
  })

  const definitions = new Map<string, Node>() // what an action can reach by name
  const shared = new Set<string>() // collections that hold the app's data
  for (const st of program.body) {
    const decl = st.type === 'ExportNamedDeclaration' ? st.declaration : st
    if (decl?.type === 'FunctionDeclaration' || decl?.type === 'ClassDeclaration') {
      if (decl.id) definitions.set(decl.id.name, decl)
    } else if (decl?.type === 'VariableDeclaration') {
      for (const d of decl.declarations) {
        if (d.id.type !== 'Identifier' || !d.init) continue
        definitions.set(d.id.name, d.init)
        const value = unwrapExpression(d.init)
        const collection = value.type === 'ArrayExpression' || (value.type === 'NewExpression' && MODULE_COLLECTION.test(lastName(value.callee)))
        if (collection && !nameWords(d.id.name).some(word => CACHE_WORD.test(word)) && !LIMITER_NAME.test(d.id.name)) shared.add(d.id.name)
      }
    }
  }

  const isGlobal = (name: string) => !imports.has(name) && !values.has(name)
  const realName = (name: string) => importedName(imports, name)

  const makesLocal = (callee: Node, depth: number): boolean => {
    if (isMember(callee)) return CRYPTO_CALL.test(propertyName(callee)) && /crypto/i.test(lastName(callee.object))
    if (callee.type !== 'Identifier' || depth > MAX_DEPTH) return false
    const source = imports.get(callee.name)
    if (source) return LOCAL_CALLS.some(([name, from]) => name.test(source.name) && from.test(source.source))
    const bound = values.get(callee.name)
    if (!bound) return LOCAL_CALLS.some(([name]) => name.test(callee.name))
    // const getMutableAIState = $getMutableAIState<AI>, in the AI SDK's own examples
    const alias = bound.length === 1 && bound[0] ? unwrapExpression(bound[0]) : null
    return alias?.type === 'TSInstantiationExpression' || alias?.type === 'Identifier'
      ? makesLocal(alias.type === 'Identifier' ? alias : unwrapExpression(alias.expression), depth + 1)
      : false
  }

  // Made by a call that stays local, or an instance of a class that does. All a class can say is that
  // its set() and delete() are its own: a real Response has no save(), so that's a model of that name.
  type Local = 'call' | 'class' | null
  const localNames = new Map<string, Local>()
  const localKind = (expression: Node, depth = 0): Local => {
    if (depth > MAX_DEPTH) return null
    const node = unwrapExpression(expression)
    if (node.type === 'TSTypeReference') {
      const name = node.typeName.type === 'Identifier' ? node.typeName.name : ''
      return isGlobal(name) && !typeNames.has(name) && LOCAL_CLASS.test(name) ? 'class' : null
    }
    if (node.type === 'NewExpression') return node.callee.type === 'Identifier' && isGlobal(node.callee.name) && LOCAL_CLASS.test(node.callee.name) ? 'class' : null
    if (isCall(node)) {
      const callee = unwrapExpression(node.callee)
      // These return what they're called on: hash.update(a).update(b), new Map().set(a, b).set(c, d)
      if (isMember(callee) && WRITE_METHOD.test(propertyName(callee))) return localKind(callee.object, depth + 1)
      return makesLocal(callee, depth + 1) ? 'call' : null
    }
    if (node.type !== 'Identifier' || imports.has(node.name) || shared.has(node.name)) return null
    const known = localNames.get(node.name)
    if (known !== undefined) return known
    localNames.set(node.name, null) // defined in terms of itself, it's not known to be anything
    const kinds = values.get(node.name)?.map(value => value && localKind(value, depth + 1)) ?? [null]
    const kind = kinds.includes(null) ? null : kinds.includes('class') ? 'class' : 'call'
    localNames.set(node.name, kind)
    return kind
  }
  const isLocal = (expression: Node) => localKind(expression) !== null

  // res.headers.set(), but not prisma.headers.delete(args): a table can have that name
  const isRequestPart = (receiver: Node): boolean => {
    if (!isMember(receiver)) return false
    const part = propertyName(receiver)
    if (part === 'searchParams') return URL_NAME.test(lastName(receiver.object)) || isLocal(receiver.object)
    return (part === 'headers' || part === 'cookies') && (REQUEST_OR_RESPONSE.test(lastName(receiver.object)) || isLocal(receiver.object))
  }

  // Object.create(null), axios.create({ baseURL }): they make no record
  const createsNoRecord = (receiver: Node): boolean => {
    if (receiver.type !== 'Identifier') return false
    const source = imports.get(receiver.name)
    if (source) return source.source === 'axios'
    return isGlobal(receiver.name) && /^(?:Object|[Aa]xios)$/.test(receiver.name)
  }

  const pushesOut = (receiver: Node, call: CallExpression | OptionalCallExpression): boolean => {
    if (receiver.type === 'Identifier') {
      if (shared.has(receiver.name)) return true
      const bound = (values.get(receiver.name) ?? []).map(value => value && unwrapExpression(value))
      if (bound.some(value => value?.type === 'ArrayExpression')) return false
      if (bound.some(value => value && isCall(value) && FIREBASE_REF.test(lastName(value.callee)))) return true
    }
    // A named event, not an array's items: hatchet.events.push('order:created', order)
    const [first, second] = call.arguments
    if (second && (first.type === 'StringLiteral' || first.type === 'TemplateLiteral')) return true
    return FIREBASE_REF_NAME.test(lastName(receiver))
  }

  const isClient = (expression: Node | null): boolean => {
    const node = expression && unwrapExpression(expression)
    if (node?.type !== 'NewExpression') return false
    const source = imports.get(rootName(node.callee))
    return !!source && AI_CLIENT.test(source.source) && !/Error$/.test(lastName(node.callee))
  }

  const callsModelApi = (call: CallExpression | OptionalCallExpression): boolean => {
    const callee = unwrapExpression(call.callee)
    if (!isMember(callee) || !MODEL_API_METHOD.test(propertyName(callee))) return false
    const api = unwrapExpression(callee.object)
    if (isMember(api) && propertyName(api) === 'completions' && lastName(api.object) === 'chat') return true
    // What the file binds it to says more than its name: const gemini = mongoose.model('Gemini')
    const root = rootName(api)
    return values.get(root)?.every(isClient) ?? AI_CLIENT_NAME.test(root)
  }

  const writes = (call: CallExpression | OptionalCallExpression): boolean => {
    const callee = unwrapExpression(call.callee)
    if (callee.type === 'Identifier') {
      const source = imports.get(callee.name)
      return !values.has(callee.name) && FIRESTORE_WRITE.test(realName(callee.name)) && (!source || /firebase/.test(source.source))
    }
    if (!isMember(callee)) return false
    const method = propertyName(callee)
    const receiver = unwrapExpression(callee.object)
    if (/^push$/i.test(method)) return pushesOut(receiver, call)
    if (!WRITE_METHOD.test(method) || callsModelApi(call)) return false
    if (/^(?:set|delete)$/i.test(method) && isRequestPart(receiver)) return false
    if (/^create$/i.test(method) && createsNoRecord(receiver)) return false
    const kind = localKind(receiver)
    return kind === null || (kind === 'class' && !/^(?:set|delete)$/i.test(method))
  }

  const isModelCall = (node: Node): boolean => {
    if (node.type === 'NewExpression') return isClient(node)
    if (!isCall(node)) return false
    if (callsModelApi(node)) return true
    const callee = unwrapExpression(node.callee)
    if (callee.type === 'Import') {
      const [source] = node.arguments
      return source?.type === 'StringLiteral' && (AI_SDK.test(source.value) || AI_CLIENT.test(source.value))
    }
    if (callee.type === 'Identifier') {
      const source = imports.get(callee.name)
      return !!source && !values.has(callee.name) && AI_SDK.test(source.source) && AI_SDK_CALL.test(source.name)
    }
    if (!isMember(callee) || callee.object.type !== 'Identifier') return false
    // import * as ai from 'ai'
    const source = imports.get(callee.object.name)
    return source?.name === '*' && AI_SDK.test(source.source) && AI_SDK_CALL.test(propertyName(callee))
  }

  const isLimit = (node: Node): boolean => {
    if (!isCall(node)) return false
    const callee = unwrapExpression(node.callee)
    const name = lastName(callee)
    const says = (word: string) => LIMIT_CALL.test(word) && !NOT_A_LIMIT.test(word)
    if (says(name)) return !(callee.type === 'Identifier' && CONCURRENCY_CAP.test(name) && isFunction(node.arguments[0]))
    if (!isMember(callee)) return false
    if (name === 'use') return node.arguments.some(arg => says(lastName(arg))) // .use(rateLimitMiddleware)
    if (!LIMIT_METHOD.test(name)) return false
    if (LIMITER.test(lastName(callee.object))) return true
    // const rl = new Ratelimit(options), or getLimiter(); rl.limit(ip)
    const receiver = unwrapExpression(callee.object)
    if (receiver.type !== 'Identifier') return false
    return (values.get(receiver.name) ?? []).some(value => {
      const made = value && unwrapExpression(value)
      return !!made && (made.type === 'NewExpression' || isCall(made)) && LIMITER.test(lastName(made.callee))
    })
  }

  const saysHarmless = (name: string): boolean => {
    if (NOT_A_WRITE.test(name) || AUTH_FLOW.test(name)) return true
    const [first, ...rest] = nameWords(name)
    if (ASKS.test(first)) return true
    if (DOES_MORE.test(name) || rest.some(word => WRITE_VERB.test(word))) return false
    return READ_VERB.test(first) || MAKES_A_VALUE.test(name)
  }

  // Only fetch()'s own default, or a method it can see: fetch(url, init) could be anything
  const fetchesARead = (call: CallExpression | OptionalCallExpression): boolean => {
    const options = call.arguments[1] && unwrapExpression(call.arguments[1])
    return !options || (options.type === 'ObjectExpression' && options.properties.every(p => p.type === 'ObjectProperty' && (lastName(p.key) !== 'method' || p.value.type === 'StringLiteral')))
  }

  const isHarmlessSource = (name: string): boolean => {
    const source = imports.get(name)?.source
    return !!source && (HARMLESS_SOURCE.test(source) || AI_CLIENT.test(source))
  }

  const isHarmlessName = (id: Node & { name: string }): boolean => {
    if (makesLocal(id, 0)) return true
    // Defined in the file, so what it does is read for itself. A parameter could be anything.
    const bound = values.get(id.name)
    if (bound) return bound.every(value => value && (isFunction(value) || isCall(unwrapExpression(value))))
    return isHarmlessSource(id.name) || HARMLESS_CALL.test(realName(id.name)) || saysHarmless(realName(id.name))
  }

  const isHarmless = (call: CallExpression | OptionalCallExpression): boolean => {
    if (isModelCall(call) || isLimit(call)) return true
    const callee = unwrapExpression(call.callee)
    if (callee.type === 'Import' || isFunction(callee)) return true
    if (callee.type === 'Identifier') {
      return realName(callee.name) === 'fetch' && !values.has(callee.name) ? fetchesARead(call) : isHarmlessName(callee)
    }
    if (!isMember(callee)) return false
    const name = propertyName(callee)
    const receiver = unwrapExpression(callee.object)
    const root = rootName(receiver)
    const [first] = call.arguments
    // Those were read above, but an array could be a queue from elsewhere
    if (WRITE_METHOD.test(name)) return true
    if (/^(?:push|unshift|splice)$/.test(name)) return !imports.has(root)
    if (CALLS_ITS_ARGUMENT.test(name) && first?.type === 'Identifier' && !isHarmlessName(first)) return false
    if (name === 'fetch') return fetchesARead(call)
    if (isLocal(receiver) || HARMLESS_ROOT.test(root) || isHarmlessSource(root) || values.get(root)?.every(isClient)) return true
    // A command says for itself: s3.send(new GetObjectCommand(params))
    if (name === 'send' && first?.type === 'NewExpression' && /Command$/.test(lastName(first.callee))) return true
    // supabase.auth.updateUser() is the caller's own. An admin client's auth.deleteUser() isn't.
    if (isMember(receiver) && propertyName(receiver) === 'auth') return true
    return HARMLESS_METHOD.test(name) || saysHarmless(name)
  }

  const isOutward = (node: Node, parent: Node | null): boolean => {
    if (node.type === 'NewExpression') return OUTWARD_COMMAND.test(lastName(node.callee))
    // A tag can hide its statement's SET in what it fills in
    if (node.type === 'TaggedTemplateExpression') return SQL_WORD.test(stringText(node.quasi) ?? '')
    if (node.type === 'StringLiteral' || node.type === 'TemplateLiteral') {
      const value = node.type === 'StringLiteral' ? node.value : node.expressions.length === 0 ? node.quasis[0].value.raw : ''
      // Passed along or typed, as a generic fetch helper's is. Not compared, and not a form's: <form method="post">
      if (parent?.type === 'JSXAttribute' || parent?.type === 'BinaryExpression' || parent?.type === 'SwitchCase') return false
      return OUTWARD_HTTP_METHOD.test(value) || (parent?.type === 'ObjectProperty' && lastName(parent.key) === 'method' && OUTWARD_HTTP_METHOD.test(value.toUpperCase()))
    }
    return isCall(node) && !isHarmless(node)
  }

  // Whether this action reaches a model with no limit on the way, following it into the helpers and
  // clients it names in the file. A catch isn't on the way: that's the provider's limit, after the fact.
  const reachesUnlimitedModel = (entry: Node): boolean => {
    let model = false
    let limit = false
    const seen = new Set<string>()
    const stack = [entry]
    while (stack.length > 0 && !limit) {
      const next = stack.pop()!
      limit = subtreeContains(next, isLimit, catches)
      walkAST(next, node => {
        if (isModelCall(node)) model = true
        else if (node.type === 'Identifier' && !seen.has(node.name)) {
          seen.add(node.name)
          const definition = definitions.get(node.name)
          if (definition) stack.push(definition)
        }
      })
    }
    return model && !limit
  }

  // Every definition these reach by name
  const reach = (entries: Node[], skip?: Set<Node>): Set<Node> => {
    const seen = new Set<string>()
    const reached = new Set<Node>()
    const stack = [...entries]
    while (stack.length > 0) {
      subtreeContains(stack.pop()!, node => {
        if (node.type === 'Identifier' && !seen.has(node.name)) {
          seen.add(node.name)
          const definition = definitions.get(node.name)
          if (definition) {
            reached.add(definition)
            stack.push(definition)
          }
        }
        return false
      }, skip)
    }
    return reached
  }

  return {
    // The functions only these actions can reach, whose code is as covered as theirs. Anything that
    // runs as the module loads could reach one too, so that counts as another way in.
    helpersOf(actions: Node[]): Node[] {
      if (actions.length === 0) return []
      const elsewhere: Node[] = []
      for (const st of program.body) {
        if (st.type !== 'VariableDeclaration') {
          if (!isFunction(st)) elsewhere.push(st)
        } else {
          for (const d of st.declarations) if (d.init && !isFunction(d.init)) elsewhere.push(d.init)
        }
      }
      const others = reach(elsewhere, new Set(actions))
      return [...reach(actions)].filter(definition => isFunction(definition) && !others.has(definition))
    },
    hasStatement: (skip: Set<Node>) => subtreeContains(program, (node, parent) => {
      if (parent?.type === 'BinaryExpression' && parent.operator === '+') return false // read from the whole
      return SQL_STATEMENT.test(stringText(node) ?? '')
    }, skip),
    // prisma.$executeRaw`…` is a call too
    hasWrite: (skip: Set<Node>) => subtreeContains(program, node =>
      isCall(node) ? writes(node) : node.type === 'TaggedTemplateExpression' && WRITE_METHOD.test(lastName(node.tag)), skip),
    hasOutward: (skip: Set<Node>) => subtreeContains(program, isOutward, skip),
    // Which actions call a model with no limit: 'open' ones could check the user, 'public' ones can't
    modelCalls(open: Node[], guests: Node[]): 'open' | 'public' | null {
      if (!subtreeContains(program, isModelCall)) return null
      const inline: Node[] = []
      walkAST(program, node => {
        if ('body' in node && node.body && typeof node.body === 'object' && 'directives' in node.body && hasDirective(node.body.directives)) inline.push(node)
      })
      const fileLevel = hasDirective(program.directives) || inline.length === 0
      if ((fileLevel ? [...open, ...inline] : inline).some(reachesUnlimitedModel)) return 'open'
      return fileLevel && guests.some(reachesUnlimitedModel) ? 'public' : null
    },
  }
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

    // A comment is no check. A file Babel can't parse is only read as text.
    const source = file.ast ? blankNodes(file.content, file.ast.comments ?? []) : file.content

    // Check for any auth pattern
    const hasAuth = AUTH_PATTERNS.some(p => p.test(source))
    if (hasAuth) return []

    // Check if path suggests public actions: they need no check on a write
    const publicPath = PUBLIC_ACTION_NAMES.some(p => p.test(file.relativePath))

    const imports = file.ast ? readImports(file.ast.program) : new Map<string, Import>()
    const { checked, guests, open, others }: Exports = file.ast ? readExports(file.ast.program, imports) : { checked: [], guests: [], open: [], others: 0 }

    // Actions built on an auth-checking client are covered. Next to other exports, their code
    // doesn't count as a mutation, and neither does the code of one that's public by design, or of
    // the helpers only those can reach.
    if (checked.length > 0 && guests.length === 0 && others === 0) return []
    const calls = file.ast ? readCalls(file.ast.program, imports) : null
    const covered = [...checked, ...guests]
    const skip = new Set<Node>([...covered, ...(calls?.helpersOf(covered) ?? [])])
    // Comments and all, so a file stays as reported as it was unless it shows otherwise
    const text = blankNodes(file.content, [...skip])
    const maybeWrite = WRITE_CALL.test(text) || SQL_WORD.test(text)

    // Check for mutations (if it's just a read action, lower concern): what's a write comes first,
    // then a model call, and only then what's kept because it can't be shown to be neither
    const writes = !publicPath && (calls ? calls.hasStatement(skip) || calls.hasWrite(skip) : maybeWrite)
    const modelCalls = writes || !calls ? null : calls.modelCalls(open, guests)
    const kept = !writes && !publicPath && maybeWrite && (calls?.hasOutward(skip) ?? false)
    const hasMutation = writes || (kept && !modelCalls)

    if (!hasMutation && !modelCalls) return []
    const does = hasMutation ? 'performs mutations' : 'calls an AI model'
    const isPublic = !hasMutation && (publicPath || modelCalls === 'public')
    // In middleware, not this action: it may not cover it. A package in the dependencies says nothing,
    // and a limit is no answer to what might be a write.
    const limited = !hasMutation && !kept && project.rateLimitsInMiddleware === true

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

    const orLimit = hasMutation ? '' : '. If it has to stay public, rate-limit it'
    const finding = { ruleId: 'server-action-auth', file: file.relativePath, line: reportLine, column: 1, category: 'security' as const }

    // There's no user to check, so a limit on what it can spend is the only fix
    if (isPublic) {
      return [{
        ...finding,
        message: limited
          ? 'Server action calls an AI model with no rate limit of its own (rate limiting detected — verify it covers this public action)'
          : 'Server action calls an AI model with no rate limit — anyone can call this public action and spend your credits',
        severity: limited ? 'info' : 'warning',
        fix: 'Rate-limit it: this action is public by design, so a limit is what bounds the bill',
      }]
    }

    return [{
      ...finding,
      message: middleware
        ? `Server action ${does} without an inline auth check (middleware auth detected — verify coverage)`
        : middlewareSkipsPages && !limited
          ? `Server action ${does} without any authentication check (middleware auth detected, but its matcher doesn't cover pages)`
          : limited
            ? `Server action ${does} without any authentication check (rate limiting detected — verify it covers this action)`
            : `Server action ${does} without any authentication check — anyone can call this action${hasMutation ? '' : ' and spend your credits'}`,
      severity: middleware || limited ? 'info' : 'warning',
      fix: middleware
        ? `Check the user in the action too, not only in middleware: const session = await auth(); if (!session) throw new Error("Unauthorized")${orLimit}`
        : `Add auth check: const session = await auth(); if (!session) throw new Error("Unauthorized")${orLimit}`,
    }]
  },
}
