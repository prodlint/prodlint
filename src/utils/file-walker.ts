import fg from 'fast-glob'
import { readFile, stat, realpath } from 'node:fs/promises'
import { resolve, extname, basename, sep } from 'node:path'
import { buildCommentMap, blankOut } from './patterns.js'
import { parseFile } from './ast.js'
import { readPackages, hasRateLimitPackage } from './package-scope.js'
import { matcherExcludesApi, matcherExcludesPages } from './middleware-matcher.js'
import type { FileContext, PackageScope, ProjectContext } from '../types.js'

const DEFAULT_IGNORES = [
  '**/node_modules/**',
  '**/dist/**',
  '**/build/**',
  '**/.next/**',
  '**/.git/**',
  '**/coverage/**',
  '**/*.min.js',
  '**/*.min.css',
  '**/package-lock.json',
  '**/yarn.lock',
  '**/pnpm-lock.yaml',
  '**/bun.lockb',
  '**/*.map',
  '**/*.d.ts',
]

const SCAN_EXTENSIONS = [
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs',
  'json', 'sql',
]

const AST_EXTENSIONS = new Set(['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs'])

const MAX_FILE_SIZE = 1024 * 1024 // 1MB

// Next.js runs middleware from the app root or src/. Next.js 16 renamed the file to proxy.
const MIDDLEWARE_FILES = [
  'middleware.ts', 'middleware.js', 'src/middleware.ts', 'src/middleware.js',
  'proxy.ts', 'proxy.js', 'src/proxy.ts', 'src/proxy.js',
]

const MIDDLEWARE_AUTH_PATTERNS = [
  /getSession/i, /getUser/i, /auth\(\)/, /withAuth/i,
  /clerkMiddleware/i, /authMiddleware/i, /NextAuth/i,
  /supabase.*auth/i, /createMiddlewareClient/i,
  /getToken/i, /verifyToken/i, /jwt/i, /updateSession/i,
  // Auth.js: export { auth as proxy } from '@/auth', export default auth((req) => …)
  /\bauth\s+as\s+(?:proxy|middleware|default)\b/, /\bauth\(/,
  // NextAuth v4: export { default } from 'next-auth/middleware'
  /['"]next-auth\/middleware['"]/,
]

const MIDDLEWARE_RATE_LIMIT_PATTERNS = [/rateLimit/i, /throttle/i]
// Calling one, which is more than a word in the file can say: a comment says nothing, and throttle()
// usually paces something
const MIDDLEWARE_RATE_LIMIT_CALL = /(?:(?:\br|R|[-_]r)ate[-_]?[lL]imit|(?:\bl|L)imiter)\w*(?:\s*\.\s*\w+)?\s*\(/

export async function walkFiles(
  root: string,
  extraIgnores: string[] = [],
): Promise<string[]> {
  const patterns = SCAN_EXTENSIONS.map(ext => `**/*.${ext}`)
  // Also grab .env files (dotfiles)
  patterns.push('**/.env', '**/.env.*')
  // Also grab .gitignore
  patterns.push('**/.gitignore')

  const files = await fg(patterns, {
    cwd: root,
    ignore: [...DEFAULT_IGNORES, ...extraIgnores],
    absolute: false,
    dot: true,
    followSymbolicLinks: false,
  })

  return files.sort()
}

export async function readFileContext(
  root: string,
  relativePath: string,
): Promise<FileContext | null> {
  try {
    const absolutePath = resolve(root, relativePath)

    // Verify the resolved path stays within the project root
    const realRoot = await realpath(root)
    const realFile = await realpath(absolutePath)
    if (!realFile.startsWith(realRoot + sep) && realFile !== realRoot) return null

    // Skip files over 1MB
    const fileStats = await stat(absolutePath)
    if (fileStats.size > MAX_FILE_SIZE) return null

    const content = await readFile(absolutePath, 'utf-8')
    const lines = content.split(/\r?\n|\r/)
    const rawExt = extname(relativePath).slice(1) // remove leading dot
    // Dotenv files (.env, .env.local, ...) have no real extension: extname() gives '' or 'local'
    const ext = /^\.env(?:\.|$)/.test(basename(relativePath)) && !SCAN_EXTENSIONS.includes(rawExt) ? 'env' : rawExt

    // Parse AST for JS/TS files (non-fatal on failure)
    let ast: FileContext['ast'] = undefined
    if (AST_EXTENSIONS.has(ext)) {
      try {
        ast = parseFile(content, relativePath)
      } catch {
        ast = null
      }
    }

    return {
      absolutePath,
      relativePath,
      content,
      lines,
      ext,
      commentMap: buildCommentMap(lines),
      ast,
    }
  } catch {
    return null
  }
}

/**
 * @param files every scanned path
 * @param sources the scanned files once read: what they import links one package to another
 */
export async function buildProjectContext(
  root: string,
  files: string[],
  sources: FileContext[] = [],
): Promise<ProjectContext> {
  let packageJson: Record<string, unknown> | null = null
  let tsconfigPaths = new Set<string>()
  let hasAuthMiddleware = false
  let authMiddlewareExcludesApi = false
  let authMiddlewareExcludesPages = false
  let rateLimitsInMiddleware = false
  let gitignoreContent: string | null = null
  let envInGitignore = false

  // Read package.json
  try {
    packageJson = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf-8'))
  } catch {
    // No package.json or invalid JSON
  }

  // Every package.json in the tree. Any of them can declare what a file imports, but a
  // file's frameworks are its own package's: an example app's ORM says nothing about the
  // code next to it. The root's are the project's
  const { declaredDependencies, frameworks } = await readPackages(root, sources)
  const detectedFrameworks = frameworks.get('') ?? new Set<string>()
  // Centralized rate limiting: a package for it, or the middleware below
  let rateLimitMiddleware = false

  // Read tsconfig.json to extract path aliases
  try {
    const raw = await readFile(resolve(root, 'tsconfig.json'), 'utf-8')
    // Strip single-line comments (tsconfig allows them)
    const stripped = raw.replace(/\/\/.*$/gm, '')
    const tsconfig = JSON.parse(stripped)
    const paths = tsconfig?.compilerOptions?.paths as Record<string, string[]> | undefined
    if (paths) {
      for (const alias of Object.keys(paths)) {
        // @components/* → @components
        // @/* → @/
        const prefix = alias.replace(/\/?\*$/, '')
        if (prefix) tsconfigPaths.add(prefix)
      }
    }
  } catch {
    // No tsconfig.json
  }

  // Check the middleware for auth and rate limiting that cover every route
  for (const name of MIDDLEWARE_FILES) {
    let content: string
    try {
      content = await readFile(resolve(root, name), 'utf-8')
    } catch {
      continue // File doesn't exist
    }
    if (MIDDLEWARE_AUTH_PATTERNS.some(p => p.test(content))) {
      // Its matcher may keep it off /api, or on /api alone; with two auth files, both must agree
      authMiddlewareExcludesApi = (!hasAuthMiddleware || authMiddlewareExcludesApi) && matcherExcludesApi(content, name)
      authMiddlewareExcludesPages = (!hasAuthMiddleware || authMiddlewareExcludesPages) && matcherExcludesPages(content, name)
      hasAuthMiddleware = true
    }
    if (MIDDLEWARE_RATE_LIMIT_PATTERNS.some(p => p.test(content))) rateLimitMiddleware = true
    // A matcher that keeps it on /api never runs on an action's POST
    if (MIDDLEWARE_RATE_LIMIT_CALL.test(blankOut(content, true)) && !matcherExcludesPages(content, name)) rateLimitsInMiddleware = true
  }

  // Read .gitignore
  try {
    gitignoreContent = await readFile(resolve(root, '.gitignore'), 'utf-8')
    envInGitignore = /^\.env$/m.test(gitignoreContent) ||
      /^\.env\*$/m.test(gitignoreContent) ||
      /^\.env\.\*$/m.test(gitignoreContent) ||
      /^\.env\.local$/m.test(gitignoreContent)
  } catch {
    // No .gitignore
  }

  // One scope per set of frameworks: the packages of a workspace share theirs
  const scopes = new Map<Set<string>, PackageScope>()
  const packageScopes = new Map<string, PackageScope>()
  for (const [folder, own] of frameworks) {
    if (!scopes.has(own)) scopes.set(own, { frameworks: own, hasRateLimiting: rateLimitMiddleware || hasRateLimitPackage(own) })
    packageScopes.set(folder, scopes.get(own)!)
  }

  return {
    root,
    packageJson,
    declaredDependencies,
    tsconfigPaths,
    hasAuthMiddleware,
    authMiddlewareExcludesApi,
    authMiddlewareExcludesPages,
    hasRateLimiting: rateLimitMiddleware || hasRateLimitPackage(detectedFrameworks),
    rateLimitsInMiddleware,
    detectedFrameworks,
    packageScopes,
    gitignoreContent,
    envInGitignore,
    allFiles: files,
  }
}
