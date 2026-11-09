import type { Rule, Finding, FileContext, ProjectContext } from '../types.js'
import type { CallExpression, MemberExpression, Node, OptionalCallExpression, OptionalMemberExpression, Program } from '@babel/types'
import { subtreeContains, unwrapExpression, walkAST } from '../utils/ast.js'
import { isApiRoute, isTestFile, nameWords, saysAuth, saysNoAuth } from '../utils/patterns.js'

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
// method or a command that says it writes. None of that is read as a write on its own: the file
// can't show what it does. This can't add a finding, only keep one, so it can afford to be broad, and
// a name missing from these lists costs what the text check always did.
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
const HARMLESS_SOURCE = /^(?:(?:node:)?(?:path|crypto|url|querystring|os)|zod|date-fns|dayjs|ms|uuid|nanoid|ulid|clsx|tailwind-merge|lodash|gray-matter|bcrypt|bcryptjs|argon2|jose|jsonwebtoken|cheerio|drizzle-orm|react|next\/(?:navigation|cache|headers|server)|ai|ai\/rsc|@ai-sdk\/[\w-]+)$/

// What goes out and stays out counts by itself, if the file shows it: a request, a file write, mail or
// a command. So does a helper from the project named like a write: few of them check the user. A
// client from another file can add the caller's token where this can't see it, and most of them do,
// so a request through one only keeps a finding, as above. What the file shows isn't a write does
// neither, whatever the method: reads, signing in, public forms, a request with the caller's token.
const HTTP_PACKAGE = /^(?:axios|ky|got|superagent|needle|node-fetch|undici|cross-fetch|isomorphic-fetch|isomorphic-unfetch|ofetch|wretch)$/
const HTTP_WRITE_CALL = /^(?:post|put|patch)$/i
const FILE_PACKAGE = /^(?:(?:node:)?fs(?:\/promises)?|fs-extra)$/
const FILE_WRITE = /^(?:writeFile|appendFile|unlink|rm|rmdir|rename|copyFile|cp|createWriteStream|truncate|outputFile|outputJson|writeJson|remove|move)(?:Sync)?$/
const FILE_CREATE = /^(?:writeFile|createWriteStream|outputFile|outputJson|writeJson)(?:Sync)?$/
const FILE_DELETE = /^(?:unlink|rm|remove)(?:Sync)?$/
const FILE_RENAME = /^(?:rename|copyFile|cp|move)(?:Sync)?$/
const AWS_WRITE_COMMAND = /^(?:Put|Delete|Copy|Send|Publish|Update|Create|Write|Upload|Complete|Transact|Batch(?:Write|Delete))\w*Command$/
const STORE_NAME = /(?:kv|bucket|r2)$|^(?:kv|bucket|r2)_/i
const WRITE_HELPER = /^(?:create|update|delete|insert|upsert|remove|destroy|save|add|write|store|upload|cancel|restore|increment|decrement|purge|wipe|clear|reset|publish|enqueue|transfer|charge|pay|refund|ban|grant|revoke|mark|submit|approve|reject|archive|move|rename|assign|invite|edit|modify|post|send)$/i
// These make or change a value, and leave the rest of the world alone
const MAKES_NO_WRITE = /^create\w*(?:Response|Api|Provider|Singleton|Action|Config|Configuration|Server|Service|Session|Template|Store|Slice|Hook|Handler|Options|Factory|Builder|Generator|Wrapper|Url|Uri|Path|Slug|Id|Key|Token|Payload|Params|Headers|FormData|Metadata|Object|Array|Map|String|Date|Range|Filter|Query)$|^add(?:Days|Hours|Minutes|Seconds|Months|Years|Weeks|Prefix|Suffix|Leading\w*|Trailing\w*)$|^remove\w*(?:Accents|Diacritics|Html|HtmlTags|Spaces|Whitespace|Empty|Duplicates|Prefix|Suffix|Markdown)$|^updateSession$|^reset(?:Form|State)$/
const LOCAL_MODULE = /^(?:\.|@\/|~\/?|#\/?|src\/|lib\/|app\/|server\/|utils\/|services\/|db\/)/
// Another action is read on its own
const ACTION_NAME = /Action$/
const ACTION_MODULE = /(?:^|\/)_?actions?(?:\/|\.|$)|\.action$/

// Read as the words of a name, a URL or a path: a request that's public by design...
const AUTH_FLOW_WORDS = /\b(?:log ?in|log ?out|sign ?in|sign ?out|sign ?up|register|forgot|otp|oauth|token|refresh|auth|password|verify|verification|create ?account|confirm ?email|magic ?link)\b/
const CAPTCHA_WORDS = /\b(?:siteverify|recaptcha|hcaptcha|turnstile|captcha)\b/
const PUBLIC_FORM_WORDS = /\b(?:contacts?|kontakt|contacto|subscribe|subscribers?|unsubscribe|newsletter|waitlist|wait ?list|feedback|leads?|enquir(?:y|ies)|inquir(?:y|ies)|rsvp|registrations?)\b/
// ...or one that reads...
const READ_URL_WORDS = /\b(?:search|query|lookup|availability|calculate|estimate|preview|validate|check(?! in\b)|translate|detect|compile|convert|summarize)\b/
const READ_SEGMENT = /^(?:get|list|fetch|find|search|query|lookup|read|load|validate|calculate|estimate|preview)$/i
const ANALYTICS_WORDS = /\b(?:posthog|plausible|mixpanel|segment|umami|analytics|telemetry)\b/
const GRAPHQL_URL_WORDS = /\b(?:graphql|gql)\b/
const NAMES_A_READ_QUERY = /^(?:get|list|fetch|find|search|read|load)$/i
const NAMES_A_MUTATION = /^(?:create|update|delete|insert|upsert|remove|destroy|save|add|write|store|upload|cancel|restore|purge|wipe|clear|reset|publish|mark|submit|approve|reject|archive|move|rename|edit|modify)$/i
const QUERY_WORD = /^(?:query|queries|document)$/i
const MUTATION = /^\s*(?:#[^\n]*\n\s*)*mutation\b/
// ...and a file or a key that doesn't last
const TEMP_WORDS = /\b(?:te?mp|tmpdir|mkdtemp|temporary)\b/
const LOG_WORDS = /\b(?:logs?|logger|logging)\b/
const CACHE_WORDS = /\b(?:cached?|caches|memo)\b/

// A header or a field that says who's calling, and an account's own mail
const CALLER_WORD = /^(?:auth|authorization|cookie|cookies|token|session|jwt|bearer)$/i
const ACCOUNT_MAIL = /\b(?:verif\w*|reset|password|otp|one ?time|welcome|confirm|magic|invit\w*|activat\w*|sign ?in|log ?in|account)\b/
// What only a server's own value is built from
const CONFIG_ROOT = /^(?:process|env|\w*[cC]onfig|CONFIG)$/
const CONSTANT_NAME = /^[A-Z][A-Z0-9_]*$/

// A check of who's calling, or a look-up of them with nothing to look up, that AUTH_PATTERNS doesn't know
const CHECKS_USER = /^(?:require|assert|ensure|must|check)\w*(?:User|Admin|Owner|Role|Permissions?|Member|Access|LoggedIn|SignedIn)\w*$|^(?:verify|validate)(?:User|Admin|Owner|Role|Permissions?|Access)$|^is(?:LoggedIn|SignedIn|Admin|Owner|Member)$|^has(?:Permission|Role|Access)s?$/
const LOOKS_UP_USER = /^(?:get|fetch|load|find)(?:Current|LoggedIn|Logged|Authenticated|Authed|Signed|Session|Server|App)?(?:User|Viewer|Me|Member|Owner)(?:Id|Session|FromServer)?$/
// ...not one that sets up an admin SDK or a client: ensureAdminInitialized(), getAdminApp()
const SETS_UP = /(?:Init|Initialized|App|Client|Sdk|SDK|Instance|Connection)$/

// A query string isn't what a URL is about
const wordsOf = (text: string) => nameWords(text.split('?')[0]).join(' ').toLowerCase()
const saysPublic = (text: string): boolean => {
  const words = wordsOf(text)
  return AUTH_FLOW_WORDS.test(words) || CAPTCHA_WORDS.test(words) || PUBLIC_FORM_WORDS.test(words)
}
// What only a public action is called, to leave what it keeps alone too: updatePassword() isn't one
const PUBLIC_BY_DESIGN = /\b(?:log ?in|log ?out|sign ?in|sign ?out|sign ?up|register|forgot)\b/
const saysPublicByDesign = (text: string): boolean => {
  const words = wordsOf(text)
  return PUBLIC_BY_DESIGN.test(words) || CAPTCHA_WORDS.test(words) || PUBLIC_FORM_WORDS.test(words)
}
const saysCaller = (name: string) => nameWords(name).some(word => CALLER_WORD.test(word))

// A model call spends the app's credits on whatever the caller sends: the AI SDK's functions, a
// client the file makes, or a .create() or the like on a client that says what it is. The SDK's
// stream and AI state don't call one: a progress bar uses them too.
const AI_SDK_CALL = /^(?:experimental_)?(?:generate(?:Text|Object|Image|Speech|Video)|stream(?:Text|Object|UI)|embed(?:Many)?|transcribe|rerank)$/
const AI_CLIENT = /^(?:openai|@anthropic-ai\/sdk|@google\/generative-ai|@google\/genai|groq-sdk|together-ai|cohere-ai|replicate|ollama|@mistralai\/mistralai|@huggingface\/inference|@aws-sdk\/client-bedrock-runtime|@langchain\/(?!core|community|langgraph|textsplitters)[\w-]+)$/
const AI_CLIENT_NAME = /^(?:open_?[aA][iI]|anthropic|groq|mistral|together|deepseek|cohere|gemini)(?:Client)?$/
const MODEL_API_METHOD = /^(?:create|stream|parse)$/
// A request to one: by the host or the path, or what a URL is called
const MODEL_URL = /api\.openai\.com|api\.anthropic\.com|generativelanguage\.googleapis\.com|api\.groq\.com|openrouter\.ai|api\.mistral\.ai|api\.deepseek\.com|api\.together\.(?:xyz|ai)|api\.perplexity\.ai|api\.cohere\.(?:ai|com)|api\.x\.ai|api\.elevenlabs\.io|api\.replicate\.com|api-inference\.huggingface\.co|api\.stability\.ai|fal\.run|\/ai\/run\/|\/chat\/completions\b|:(?:stream)?[gG]enerateContent\b|\/v1\/messages\b/
const MODEL_WORDS = /\b(?:openai|anthropic|gemini|groq|deepseek|mistral|openrouter)\b/

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
// How far to read what a URL or a value is built from
const MAX_SHOWN = 8

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

const keyName = (key: Node): string => key.type === 'StringLiteral' ? key.value : lastName(key)

const propertyOf = (object: Node | null | undefined, key: RegExp): Node | null => {
  if (object?.type !== 'ObjectExpression') return null
  for (const p of object.properties) {
    if (p.type === 'ObjectProperty' && key.test(keyName(p.key))) return p.value
  }
  return null
}

// The strings in what's sent: a contact: phone field isn't a contact form
function stringsIn(node: Node): string {
  const strings: string[] = []
  walkAST(node, n => {
    if (n.type === 'StringLiteral') strings.push(n.value)
    else if (n.type === 'TemplateLiteral') strings.push(n.quasis.map(q => q.value.raw).join(' '))
  })
  return strings.join(' ')
}

interface HttpRequest {
  url: Node | null | undefined
  body: Node | null | undefined
  options: Node | null | undefined
  headers: Node | null
  methods: Node[] // the strings that say which method, if any do
  hidden: boolean // through a client the file doesn't show
  client?: { config: Node | null; axios: boolean } | null
  receiver?: Node
}

// What a call does outside the process. writes: true counts, false doesn't and keeps nothing, and null
// is out of sight, so it can only keep a finding.
interface Effect {
  does: string
  writes: boolean | null
  methods?: Node[]
  named?: boolean // only a name says so
}

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
  const fromEnv = new Set<string>() // const { SMTP_EMAIL } = process.env
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
      if (node.id.type === 'ObjectPattern' && node.init && lastName(node.init) === 'env') {
        for (const p of node.id.properties) if (p.type === 'ObjectProperty' && p.value.type === 'Identifier') fromEnv.add(p.value.name)
      }
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
    if (/^delete$/i.test(method) && clientOf(receiver)) {
      const request = requestOf(call)
      return !request || !isNoWriteRequest(request) // the caller's token, a login proxy...
    }
    if (/^(?:set|delete)$/i.test(method) && isRequestPart(receiver)) return false
    if (/^create$/i.test(method) && createsNoRecord(receiver)) return false
    const kind = localKind(receiver)
    return kind === null || (kind === 'class' && !/^(?:set|delete)$/i.test(method))
  }

  // What a name stands for, if that's one thing
  const boundOnce = (expression: Node): Node => {
    let node = unwrapExpression(expression)
    const seen = new Set<string>()
    while (node.type === 'Identifier' && !seen.has(node.name)) {
      seen.add(node.name)
      const bound = values.get(node.name)
      if (bound?.length !== 1 || !bound[0] || bound[0].type === 'TSTypeReference') break
      node = unwrapExpression(bound[0])
    }
    return node
  }

  // What a URL, a path or a key shows: its strings, and the names it's built from. A plain parameter
  // filled into a template says nothing about what the URL is for.
  // A plain parameter handed to what builds a URL doesn't either, if quiet.
  const shown = (expression: Node | null | undefined, depth = 0, inTemplate = false, quiet = false): string => {
    if (!expression || depth > MAX_SHOWN) return ''
    const node = unwrapExpression(expression)
    const part = (n: Node | null | undefined) => shown(n, depth + 1, false, quiet)
    if (node.type === 'StringLiteral') return node.value
    if (node.type === 'TemplateLiteral') {
      return node.quasis.map((q, i) => `${q.value.raw} ${node.expressions[i] ? shown(node.expressions[i], depth + 1, true, quiet) : ''}`).join(' ')
    }
    if (node.type === 'BinaryExpression' || node.type === 'LogicalExpression') return `${part(node.left)} ${part(node.right)}`
    if (node.type === 'ConditionalExpression') return `${part(node.consequent)} ${part(node.alternate)}`
    if (node.type === 'Identifier') {
      const value = boundOnce(node)
      const follow = value.type !== 'Identifier' ? part(value) : ''
      return inTemplate && !follow && !CONSTANT_NAME.test(node.name) ? '' : `${node.name} ${follow}`
    }
    if (isMember(node)) return `${part(node.object)} ${propertyName(node)}`
    if (isCall(node) || node.type === 'NewExpression') return `${lastName(node.callee)} ${node.arguments.map(n => shown(n, depth + 1, quiet, quiet)).join(' ')}`
    if (node.type === 'ObjectExpression') {
      return node.properties.map(p => p.type === 'ObjectProperty' ? `${keyName(p.key)} ${part(p.value)}` : p.type === 'SpreadElement' ? part(p.argument) : '').join(' ')
    }
    return node.type === 'ArrayExpression' ? node.elements.map(part).join(' ') : ''
  }

  // Whose a value is. The server's: a string, an env var, a constant, or one of those encoded. Anything
  // else is the caller's, or out of sight: a parameter, a cookie, what a helper returns.
  const isFixed = (expression: Node | null | undefined, depth = 0): boolean => {
    if (!expression || depth > MAX_SHOWN) return false
    const node = unwrapExpression(expression)
    const fixed = (n: Node | null | undefined) => isFixed(n, depth + 1)
    if (node.type === 'StringLiteral' || node.type === 'NumericLiteral' || node.type === 'BooleanLiteral' || node.type === 'NullLiteral') return true
    if (node.type === 'TemplateLiteral') return node.expressions.every(fixed)
    if (node.type === 'BinaryExpression' || node.type === 'LogicalExpression') return fixed(node.left) && fixed(node.right)
    if (node.type === 'ConditionalExpression') return fixed(node.consequent) && fixed(node.alternate)
    if (node.type === 'ArrayExpression') return node.elements.every(fixed)
    if (isMember(node)) return (CONFIG_ROOT.test(rootName(node)) && !values.get(rootName(node))?.includes(null)) || fixed(node.object)
    if (isCall(node)) {
      const callee = unwrapExpression(node.callee)
      if (isMember(callee) && lastName(callee.object) !== 'Buffer' && !fixed(callee.object)) return false
      return (node.arguments.length > 0 || isMember(callee)) && node.arguments.every(fixed)
    }
    if (node.type !== 'Identifier') return false
    if (fromEnv.has(node.name)) return true
    const bound = values.get(node.name)
    return bound ? bound.every(value => !!value && fixed(value)) : CONSTANT_NAME.test(node.name)
  }

  // What's given the caller's token after it's made: headers.set('Authorization', token), or an
  // interceptor, which is what it's for
  let tokenBearers: Set<string> | undefined
  const bearsToken = (name: string, at: Node): boolean => {
    if (!tokenBearers) {
      const bearers = new Set<string>()
      const add = (n: Node, root: string) => bearers.add(isFunction(topLevelOf(n)) || topLevelOf(n).type === 'ExportNamedDeclaration' || topLevelOf(n).type === 'ExportDefaultDeclaration' ? `${root}@${topLevelOf(n).start}` : root)
      walkAST(program, n => {
        if (n.type === 'AssignmentExpression' && isMember(n.left)) {
          if (saysCaller(n.left.computed ? shown(n.left.property) : propertyName(n.left)) && !isFixed(n.right)) add(n, rootName(n.left))
        } else if (isMember(n) && propertyName(n) === 'interceptors') {
          bearers.add(rootName(n))
        } else if (isCall(n)) {
          const callee = unwrapExpression(n.callee)
          if (isMember(callee) && /^(?:set|append)$/.test(propertyName(callee)) && saysCaller(shown(n.arguments[0])) && !isFixed(n.arguments[1])) add(n, rootName(callee.object))
        }
      })
      tokenBearers = bearers
    }
    return tokenBearers.has(name) || tokenBearers.has(`${name}@${topLevelOf(at).start}`)
  }

  // A field that says who's calling in a way a backend can check. The server's own secret doesn't.
  const namesCaller = (p: Node): boolean => p.type === 'ObjectProperty' && saysCaller(keyName(p.key)) && !isFixed(p.value)

  // Whether these headers do that, and whatever a parameter or a helper holds could
  const forwardsToken = (headers: Node | null | undefined, depth = 0): boolean => {
    if (!headers || depth > MAX_SHOWN) return false
    const node = unwrapExpression(headers)
    if (node.type === 'Identifier') return bearsToken(node.name, node) || (!isFixed(node) && (values.get(node.name) ?? [null]).some(value => !value || forwardsToken(value, depth + 1)))
    if (node.type === 'NewExpression' && lastName(node.callee) === 'Headers') return forwardsToken(node.arguments[0], depth + 1)
    if (node.type !== 'ObjectExpression') return true
    return node.properties.some(p => p.type === 'SpreadElement' ? !isFixed(p.argument) && forwardsToken(p.argument, depth + 1) : namesCaller(p))
  }

  const importedFrom = (name: string, source: RegExp): boolean => {
    const from = imports.get(name)?.source
    return !!from && source.test(from)
  }

  // axios and the like, or a client the file makes of one, and the config it was made with
  const clientOf = (expression: Node): HttpRequest['client'] => {
    const node = unwrapExpression(expression)
    if (node.type !== 'Identifier') return null
    const made = boundOnce(node)
    if (made === node) return importedFrom(node.name, HTTP_PACKAGE) ? { config: null, axios: importedFrom(node.name, /^axios$/) } : null
    if (!isCall(made)) return null
    const callee = unwrapExpression(made.callee)
    if (!isMember(callee) || !/^(?:create|extend)$/.test(propertyName(callee)) || !importedFrom(rootName(callee), HTTP_PACKAGE)) return null
    return { config: made.arguments[0] ?? null, axios: importedFrom(rootName(callee), /^axios$/) }
  }

  const methodsIn = (options: Node | null): Node[] => {
    const method = propertyOf(options, /^method$/)
    if (!method) return []
    const value = boundOnce(method)
    return (value.type === 'ConditionalExpression' ? [value.consequent, value.alternate] : [value]).filter(n => OUTWARD_HTTP_METHOD.test(shown(n).toUpperCase().trim()))
  }

  // A request by its options: fetch(url, init), axios(config)
  const configured = (options: Node | null, url: Node | null | undefined, hidden: boolean, client?: HttpRequest['client'], receiver?: Node): HttpRequest | null => {
    const methods = methodsIn(options)
    if (methods.length === 0) return null
    return { url: url ?? propertyOf(options, /^url$/), options, body: propertyOf(options, /^(?:body|data|json|form)$/), headers: propertyOf(options, /^headers$/), methods, hidden, client, receiver }
  }

  const isStore = (receiver: Node): boolean => rootName(receiver) === 'env' || STORE_NAME.test(lastName(receiver))
  const isCacheApi = (receiver: Node): boolean => /^caches?$/i.test(lastName(receiver))

  const readRequest = (call: CallExpression | OptionalCallExpression): HttpRequest | null => {
    const callee = unwrapExpression(call.callee)
    const [first, second, third] = call.arguments
    if (callee.type === 'Identifier') {
      if (realName(callee.name) === 'fetch' && (importedFrom(callee.name, HTTP_PACKAGE) || isGlobal(callee.name))) {
        const made = first && unwrapExpression(first)
        if (made?.type === 'NewExpression' && lastName(made.callee) === 'Request') return configured(made.arguments[1] ? boundOnce(made.arguments[1]) : null, made.arguments[0], false)
        return configured(second ? boundOnce(second) : null, first, false)
      }
      return importedFrom(callee.name, HTTP_PACKAGE) && first ? configured(boundOnce(first), null, false) : null
    }
    if (!isMember(callee)) return null
    const name = propertyName(callee)
    const receiver = unwrapExpression(callee.object)
    // A binding the platform gave the file, or something from another one: sdk.client.fetch()
    if (name === 'fetch' && second) {
      const root = rootName(receiver)
      return configured(boundOnce(second), first, root !== 'env' && !values.get(root)?.every(value => value && rootName(value) === 'env'))
    }
    const client = clientOf(receiver)
    if (name === 'request' && client && first) return configured(boundOnce(first), null, false, client, receiver)
    if (client && (HTTP_WRITE_CALL.test(name) || /^delete$/i.test(name))) {
      // axios has the data second, unless there's none to send. The rest have it in their options.
      const options = /^delete$/i.test(name) || !client.axios ? second : third
      const read = options ? boundOnce(options) : null
      return { url: first, body: client.axios ? second : propertyOf(read, /^(?:json|body|form)$/), options: read, headers: propertyOf(read, /^headers$/), methods: [], hidden: false, client, receiver }
    }
    // Upper case is an OpenAPI client's: apiClient.POST(url, input). A store and a cache have a put() of their own.
    if (!HTTP_WRITE_CALL.test(name) || (name === 'put' && (isStore(receiver) || isCacheApi(receiver)))) return null
    return { url: first, body: second, options: third, headers: null, methods: [], hidden: true }
  }
  const requests = new Map<Node, HttpRequest | null>()
  const requestOf = (call: CallExpression | OptionalCallExpression): HttpRequest | null => {
    let request = requests.get(call)
    if (request === undefined) {
      request = readRequest(call)
      requests.set(call, request)
    }
    return request
  }

  const payloadOf = (request: HttpRequest): Node | null => {
    const sent = request.body && unwrapExpression(request.body)
    if (!sent) return null
    return isCall(sent) && lastName(sent.callee) === 'stringify' && sent.arguments[0] ? boundOnce(sent.arguments[0]) : boundOnce(sent)
  }

  let mutationInFile: boolean | undefined
  const fileHasMutation = () => mutationInFile ??= subtreeContains(program, node =>
    node.type === 'Identifier' ? nameWords(node.name).some(word => /^mutations?$/i.test(word)) : /\bmutation\b/.test(stringText(node) ?? ''))

  // A GraphQL query goes over POST. Read by its text, or else by what it's called, and a query in a
  // file with a mutation in it could be that.
  const readsGraphQL = (payload: Node | null, urlWords: string): boolean => {
    const query = propertyOf(payload, /^query$/)
    if (!query && !GRAPHQL_URL_WORDS.test(urlWords)) return false
    if (!query) return !fileHasMutation()
    const value = boundOnce(query)
    const text = stringText(value.type === 'TaggedTemplateExpression' ? value.quasi : value)
    if (text !== null) return !MUTATION.test(text)
    if (!propertyOf(payload, /^variables$/) && !GRAPHQL_URL_WORDS.test(urlWords) && unwrapExpression(query).type !== 'Identifier') return false
    const words = nameWords(lastName(unwrapExpression(query)))
    if (words.some(word => /^mutations?$/i.test(word)) || NAMES_A_MUTATION.test(words[0] ?? '')) return false
    return NAMES_A_READ_QUERY.test(words[0] ?? '') || (words.length > 1 && words.some(word => QUERY_WORD.test(word))) || !fileHasMutation()
  }

  // A chat completion's shape, whoever hosts it
  const looksLikeChat = (payload: Node | null) => !!propertyOf(payload, /^model$/) && !!propertyOf(payload, /^(?:messages|prompt)$/)

  // A model behind a request. Through a client the file doesn't show, only by the host: that could be
  // the app's own backend.
  const urlOf = (request: HttpRequest) => shown(request.url, 0, false, true)

  const requestsModel = (request: HttpRequest): boolean => {
    const url = urlOf(request)
    return MODEL_URL.test(url) || (!request.hidden && (MODEL_WORDS.test(wordsOf(url)) || looksLikeChat(payloadOf(request))))
  }

  const isNoWriteRequest = (request: HttpRequest): boolean => {
    const url = urlOf(request)
    const words = wordsOf(url)
    const payload = payloadOf(request)
    const to = propertyOf(payload, /^to$/)
    // The URL's own last part: what a helper that builds one is called says nothing
    const segment = request.url ? stringsIn(boundOnce(request.url)).split('?')[0].split(/[/\s]+/).filter(Boolean).pop() ?? '' : ''
    return requestsModel(request) ||
      CAPTCHA_WORDS.test(words) ||
      /\bgrant_type\b/.test(`${url} ${shown(request.body)} ${shown(request.options)}`) ||
      AUTH_FLOW_WORDS.test(words) ||
      readsGraphQL(payload, words) ||
      // fetch() caches what it's told to, and a write isn't that
      propertyOf(request.options, /^next$/)?.type === 'ObjectExpression' || shown(propertyOf(request.options, /^cache$/)) === 'force-cache' ||
      // The caller's token, however it gets there
      forwardsToken(request.headers) || !!propertyOf(request.options, /^(?:credentials|withCredentials)$/) ||
      forwardsToken(propertyOf(request.client?.config, /^headers$/)) ||
      (request.receiver?.type === 'Identifier' && bearsToken(request.receiver.name, request.receiver)) ||
      (payload?.type === 'ObjectExpression' && payload.properties.some(namesCaller)) ||
      // Mail over HTTP, by the same test as other mail
      (!!to && isFixed(to)) ||
      ANALYTICS_WORDS.test(words) ||
      READ_URL_WORDS.test(words) || READ_SEGMENT.test(nameWords(segment)[0] ?? '') ||
      PUBLIC_FORM_WORDS.test(words) || (!!request.body && PUBLIC_FORM_WORDS.test(wordsOf(stringsIn(boundOnce(request.body))))) ||
      (!!propertyOf(payload, /^email$/) && !!propertyOf(payload, /^message$/)) // a contact form's shape
  }

  const fileCallOf = (call: CallExpression | OptionalCallExpression): string | null => {
    const callee = unwrapExpression(call.callee)
    if (callee.type === 'Identifier') return importedFrom(callee.name, FILE_PACKAGE) && FILE_WRITE.test(realName(callee.name)) ? realName(callee.name) : null
    if (!isMember(callee) || !FILE_WRITE.test(propertyName(callee))) return null
    const root = rootName(callee)
    if (importedFrom(root, FILE_PACKAGE)) return propertyName(callee)
    // const fs = require('fs')
    return values.get(root)?.some(value => {
      const made = value && unwrapExpression(value)
      return !!made && isCall(made) && lastName(made.callee) === 'require' && FILE_PACKAGE.test(shown(made.arguments[0]))
    }) ? propertyName(callee) : null
  }

  // The top-level statement a node is in
  const parents = new Map<Node, Node | null>()
  const topLevelOf = (node: Node): Node => {
    if (parents.size === 0) walkAST(program, (n, parent) => { parents.set(n, parent ?? null) })
    let at = node
    for (let parent = parents.get(at); parent && parent !== program; parent = parents.get(at)) at = parent
    return at
  }

  // What a function writes, then deletes on the way out, is a temp file. In a catch, that's a rollback.
  const tempFiles = new Map<Node, Set<string>>()
  const tempFilesIn = (statement: Node): Set<string> => {
    let temp = tempFiles.get(statement)
    if (!temp) {
      const found = new Set<string>()
      const written = new Set<string>()
      subtreeContains(statement, node => {
        const called = isCall(node) ? fileCallOf(node) : null
        const path = called && isCall(node) ? shown(node.arguments[0]) : ''
        if (path && FILE_CREATE.test(called ?? '')) written.add(path)
        else if (path && FILE_DELETE.test(called ?? '') && written.has(path)) found.add(path)
        return false
      }, catches)
      tempFiles.set(statement, found)
      temp = found
    }
    return temp
  }

  const isNoWriteFile = (call: CallExpression | OptionalCallExpression, name: string): boolean => {
    const words = wordsOf(shown(FILE_RENAME.test(name) ? call.arguments[1] : call.arguments[0]))
    if (TEMP_WORDS.test(words) || LOG_WORDS.test(words) || CACHE_WORDS.test(words) || PUBLIC_FORM_WORDS.test(words)) return true
    return !FILE_RENAME.test(name) && tempFilesIn(topLevelOf(call)).has(shown(call.arguments[0]))
  }

  // Every object a name stands for, or null if it stands for anything else
  const objectsOf = (expression: Node | undefined): Node[] | null => {
    const node = expression && unwrapExpression(expression)
    if (node?.type === 'ObjectExpression') return [node]
    if (node?.type !== 'Identifier') return null
    const objects = (values.get(node.name) ?? [null]).map(value => value && unwrapExpression(value))
    return objects.every(value => value?.type === 'ObjectExpression') ? objects as Node[] : null
  }

  // Mail to one address that doesn't change is a contact form. To an address the caller can set, it's a
  // relay, unless it says it's an account's own: how signing in works, as with a login proxy.
  const isNoWriteMail = (options: Node | undefined): boolean => {
    const objects = objectsOf(options)
    if (!objects) return false
    const fixedAddress = objects.every(object => {
      const to = propertyOf(object, /^[tT]o$/) ?? propertyOf(propertyOf(object, /^Destination$/), /^ToAddresses$/)
      return to ? isFixed(to) : object.type === 'ObjectExpression' && !object.properties.some(p => p.type === 'SpreadElement')
    })
    if (fixedAddress) return true
    const says = objects.map(object => {
      const content = propertyOf(object, /^(?:html|text)$/)
      const named = content && isCall(unwrapExpression(content)) ? lastName(content) : ''
      return wordsOf(`${shown(propertyOf(object, /^[sS]ubject$/))} ${shown(propertyOf(object, /^(?:react|template|templateId)$/))} ${named}`)
    }).join(' ')
    return ACCOUNT_MAIL.test(says) || AUTH_FLOW_WORDS.test(says) || PUBLIC_FORM_WORDS.test(says)
  }

  const isMail = (call: CallExpression | OptionalCallExpression): boolean => {
    const callee = unwrapExpression(call.callee)
    if (!isMember(callee)) return false
    const name = propertyName(callee)
    if (name === 'sendMail' || name === 'sendEmail') return true
    if (name !== 'send') return false
    const receiver = unwrapExpression(callee.object)
    return (isMember(receiver) && /^(?:emails|batch)$/.test(propertyName(receiver))) || /^(?:sgMail|sendgrid|mailer|mail)$/i.test(lastName(receiver)) || importedFrom(rootName(receiver), /sendgrid/)
  }

  // sendEmail(), or a helper from the project named like a write
  const helperEffect = (call: CallExpression | OptionalCallExpression, callee: Node & { name: string }): Effect | null => {
    const name = realName(callee.name)
    if (/^send\w*(?:Mail|Email)\w*$/i.test(name)) {
      const [first] = call.arguments
      // With nothing to go on, the helper picks the address
      if (!first) return { does: 'sends email', writes: null }
      const noWrite = ACCOUNT_MAIL.test(wordsOf(name)) || AUTH_FLOW_WORDS.test(wordsOf(name)) || (objectsOf(first) ? isNoWriteMail(first) : isFixed(first))
      return { does: 'sends email', writes: !noWrite }
    }
    const words = nameWords(name)
    if (!importedFrom(callee.name, LOCAL_MODULE) || words.length < 2 || !WRITE_HELPER.test(words[0]) || isHarmlessName(callee)) return null
    // Not counted isn't shown harmless: resetPassword() is a write, whatever else it is
    const counts = !MAKES_NO_WRITE.test(name) && !ACTION_NAME.test(name) && !importedFrom(callee.name, ACTION_MODULE) && !saysPublic(name) && !call.arguments.some(arg => saysCaller(lastName(arg)))
    return { does: `calls ${name}(), which reads as a write,`, writes: counts ? true : null, named: true }
  }

  const readEffect = (node: Node): Effect | null => {
    if (node.type === 'NewExpression') {
      const name = realName(lastName(node.callee))
      if (!AWS_WRITE_COMMAND.test(name) || !importedFrom(rootName(node.callee), /^@aws-sdk\//)) return null
      return /Email/.test(name) ? { does: 'sends email', writes: !isNoWriteMail(node.arguments[0]) } : { does: 'writes to a cloud service', writes: true }
    }
    if (!isCall(node)) return null
    const request = requestOf(node)
    // Out of sight it can't count, but a URL can still say it isn't a write
    if (request) return { does: 'sends a write request', writes: isNoWriteRequest(request) ? false : request.hidden ? null : true, methods: request.methods }
    const file = fileCallOf(node)
    if (file) return { does: 'writes files', writes: !isNoWriteFile(node, file) }
    const callee = unwrapExpression(node.callee)
    if (isMember(callee) && propertyName(callee) === 'put' && isStore(unwrapExpression(callee.object))) {
      const key = wordsOf(shown(node.arguments[0]))
      const noWrite = CACHE_WORDS.test(key) || AUTH_FLOW_WORDS.test(key) || PUBLIC_FORM_WORDS.test(key) || PUBLIC_FORM_WORDS.test(wordsOf(lastName(callee.object)))
      return { does: 'writes to a cloud service', writes: !noWrite }
    }
    if (isMember(callee) && propertyName(callee) === 'put' && isCacheApi(unwrapExpression(callee.object))) return { does: 'writes to a cloud service', writes: false }
    if (callee.type !== 'Identifier') return isMail(node) ? { does: 'sends email', writes: !isNoWriteMail(node.arguments[0]) } : null
    if (!imports.has(callee.name) || values.has(callee.name)) return null
    if (importedFrom(callee.name, /^@vercel\/blob$/) && /^(?:put|del|copy)$/.test(realName(callee.name))) return { does: 'writes to a cloud service', writes: true }
    return helperEffect(node, callee)
  }
  const effects = new Map<Node, Effect | null>()
  const effectOf = (node: Node): Effect | null => {
    if (node.type !== 'NewExpression' && !isCall(node)) return null
    let effect = effects.get(node)
    if (effect === undefined) {
      effect = readEffect(node)
      effects.set(node, effect)
    }
    return effect
  }

  // mustCreateUser() isn't one
  const checksUser = (node: Node): boolean => {
    if (!isCall(node)) return false
    const name = realName(lastName(node.callee))
    if (SETS_UP.test(name)) return false
    return (CHECKS_USER.test(name) && !nameWords(name).slice(1).some(word => WRITE_VERB.test(word))) || (LOOKS_UP_USER.test(name) && node.arguments.length === 0)
  }

  const isModelCall = (node: Node): boolean => {
    if (node.type === 'NewExpression') return isClient(node)
    if (!isCall(node)) return false
    if (callsModelApi(node)) return true
    const request = requestOf(node)
    if (request && requestsModel(request)) return true
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
    if (isModelCall(call) || isLimit(call) || effectOf(call)?.writes === false) return true
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
    if (name === 'extend' && importedFrom(root, HTTP_PACKAGE)) return true // ky.extend(): a client, as axios.create() is
    if (isLocal(receiver) || HARMLESS_ROOT.test(root) || isHarmlessSource(root) || values.get(root)?.every(isClient)) return true
    // A command says for itself: s3.send(new GetObjectCommand(params))
    if (name === 'send' && first?.type === 'NewExpression' && /Command$/.test(lastName(first.callee))) return true
    // supabase.auth.updateUser() is the caller's own. An admin client's auth.deleteUser() isn't.
    if (isMember(receiver) && propertyName(receiver) === 'auth') return true
    return HARMLESS_METHOD.test(name) || saysHarmless(name)
  }

  // The method strings of the requests that aren't writes
  let noWriteMethods: Set<Node> | undefined
  const isNoWriteMethod = (node: Node): boolean => {
    if (!noWriteMethods) {
      const methods = new Set<Node>()
      walkAST(program, n => {
        const effect = effectOf(n)
        if (effect?.writes === false) effect.methods?.forEach(method => methods.add(method))
      })
      noWriteMethods = methods
    }
    return noWriteMethods.has(node)
  }

  const isOutward = (node: Node, parent: Node | null): boolean => {
    if (node.type === 'NewExpression') return OUTWARD_COMMAND.test(lastName(node.callee)) && effectOf(node)?.writes !== false
    if (isNoWriteMethod(node)) return false
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

  // The actions in a file: its exports, if the file is marked as actions, and what's marked on its own
  const inlineActions = (): { inline: Node[]; fileLevel: boolean } => {
    const inline: Node[] = []
    walkAST(program, node => {
      if ('body' in node && node.body && typeof node.body === 'object' && 'directives' in node.body && hasDirective(node.body.directives)) inline.push(node)
    })
    return { inline, fileLevel: hasDirective(program.directives) || inline.length === 0 }
  }

  // What an export is called, whatever form it takes
  let constNames: Map<Node, string> | undefined
  const actionName = (action: Node): string => {
    if (action.type === 'Identifier') return action.name
    if (action.type === 'FunctionDeclaration' || action.type === 'ClassDeclaration') return action.id?.name ?? ''
    if (!constNames) {
      constNames = new Map()
      for (const st of program.body) {
        const decl = st.type === 'ExportNamedDeclaration' ? st.declaration : st
        if (decl?.type !== 'VariableDeclaration') continue
        for (const d of decl.declarations) if (d.init && d.id.type === 'Identifier') constNames.set(d.init, d.id.name)
      }
    }
    return constNames.get(action) ?? ''
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
    // Actions that say they're public by design, or check the user in a way AUTH_PATTERNS doesn't know.
    // What goes out and stays out doesn't count in these, or keep a finding.
    // An action with only an auth word in its name (updatePassword) still keeps one.
    leftAlone(open: Node[], skip: Set<Node>): { outward: Node[]; kept: Node[] } {
      const { inline, fileLevel } = inlineActions()
      const anyChecks = subtreeContains(program, checksUser, skip)
      const actions = fileLevel ? [...open, ...inline] : inline
      const checks = (action: Node) => anyChecks && [action, ...reach([action], skip)].some(definition => subtreeContains(definition, checksUser, skip))
      const withValues = (list: Node[]) => list.flatMap(action => action.type === 'Identifier' && definitions.has(action.name) ? [action, definitions.get(action.name)!] : [action])
      return {
        outward: withValues(actions.filter(action => saysPublic(actionName(action)) || checks(action))),
        kept: withValues(actions.filter(action => saysPublicByDesign(actionName(action)) || checks(action))),
      }
    },
    // What goes out and stays out, read per action. What the file shows comes before what only a name says.
    outwardWrite(open: Node[], alone: Node[], skip: Set<Node>): Effect | null {
      if (!subtreeContains(program, node => !!effectOf(node)?.writes, skip)) return null
      const { inline, fileLevel } = inlineActions()
      const actions = (fileLevel ? [...open, ...inline] : inline).filter(action => !alone.includes(action))
      let found: Effect | null = null
      for (const definition of [...actions, ...reach(actions, skip)]) {
        const shows = subtreeContains(definition, node => {
          const effect = effectOf(node)
          if (effect?.writes) found = found && !effect.named ? effect : found ?? effect
          return !!effect?.writes && !effect.named
        }, skip)
        if (shows) break
      }
      return found
    },
    // Which actions call a model with no limit: 'open' ones could check the user, 'public' ones can't
    modelCalls(open: Node[], guests: Node[]): 'open' | 'public' | null {
      if (!subtreeContains(program, isModelCall)) return null
      const { inline, fileLevel } = inlineActions()
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
    // then what goes out and stays out, then a model call, then what only a name says is a write, and
    // only then what's kept because it can't be shown to be neither. A route handler is auth-checks'
    // to read, even with the directive.
    const writes = !publicPath && (calls ? calls.hasStatement(skip) || calls.hasWrite(skip) : maybeWrite)
    const alone = calls?.leftAlone(open, skip) ?? { outward: [], kept: [] }
    const outward = writes || !calls || publicPath || saysPublic(file.relativePath) || isApiRoute(file.relativePath) ? null : calls.outwardWrite(open, alone.outward, skip)
    const modelCalls = writes || (outward && !outward.named) || !calls ? null : calls.modelCalls(open, guests)
    const keptSkip = alone.kept.length && calls ? new Set<Node>([...skip, ...alone.kept, ...calls.helpersOf([...covered, ...alone.kept])]) : skip
    const kept = !writes && !outward && !publicPath && maybeWrite && (calls?.hasOutward(keptSkip) ?? false)
    const hasMutation = writes || (!!outward && !modelCalls) || (kept && !modelCalls)

    if (!hasMutation && !modelCalls) return []
    const does = hasMutation ? outward?.does ?? 'performs mutations' : 'calls an AI model'
    const isPublic = !hasMutation && (publicPath || modelCalls === 'public')
    // In middleware, not this action: it may not cover it. A package in the dependencies says nothing,
    // and a limit is no answer to what might be a write.
    const limited = !hasMutation && !kept && !outward && project.rateLimitsInMiddleware === true

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
    // A helper's directive can make it an action by accident, and then a check would lock out its callers
    const orRemove = hasMutation && outward ? ". If only server code calls it, remove 'use server' instead" : ''
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
        ? `Check the user in the action too, not only in middleware: const session = await auth(); if (!session) throw new Error("Unauthorized")${orLimit}${orRemove}`
        : `Add auth check: const session = await auth(); if (!session) throw new Error("Unauthorized")${orLimit}${orRemove}`,
    }]
  },
}
