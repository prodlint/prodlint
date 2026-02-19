import fg from 'fast-glob'
import { readFile, stat, realpath } from 'node:fs/promises'
import { resolve, extname, sep } from 'node:path'
import { buildCommentMap } from './patterns.js'
import { parseFile } from './ast.js'
import { DEPENDENCY_TO_FRAMEWORK, RATE_LIMIT_FRAMEWORKS } from './frameworks.js'
import type { FileContext, ProjectContext } from '../types.js'

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
    const ext = extname(relativePath).slice(1) // remove leading dot

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

export async function buildProjectContext(
  root: string,
  files: string[],
): Promise<ProjectContext> {
  let packageJson: Record<string, unknown> | null = null
  let declaredDependencies = new Set<string>()
  let tsconfigPaths = new Set<string>()
  let hasAuthMiddleware = false
  let hasRateLimiting = false
  const detectedFrameworks = new Set<string>()
  let gitignoreContent: string | null = null
  let envInGitignore = false

  // Read package.json
  try {
    const raw = await readFile(resolve(root, 'package.json'), 'utf-8')
    packageJson = JSON.parse(raw)
    const deps = {
      ...(packageJson?.dependencies as Record<string, string> ?? {}),
      ...(packageJson?.devDependencies as Record<string, string> ?? {}),
      ...(packageJson?.peerDependencies as Record<string, string> ?? {}),
    }
    declaredDependencies = new Set(Object.keys(deps))

    // Detect frameworks from dependencies
    for (const dep of declaredDependencies) {
      const framework = DEPENDENCY_TO_FRAMEWORK[dep]
      if (framework) {
        detectedFrameworks.add(framework)
      }
    }

    // Check for centralized rate limiting
    for (const framework of detectedFrameworks) {
      if (RATE_LIMIT_FRAMEWORKS.has(framework)) {
        hasRateLimiting = true
        break
      }
    }
  } catch {
    // No package.json or invalid JSON
  }

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

  // Check for auth middleware (middleware.ts or middleware.js in root)
  try {
    for (const name of ['middleware.ts', 'middleware.js', 'src/middleware.ts', 'src/middleware.js']) {
      try {
        const content = await readFile(resolve(root, name), 'utf-8')
        const authPatterns = [
          /getSession/i, /getUser/i, /auth\(\)/, /withAuth/i,
          /clerkMiddleware/i, /authMiddleware/i, /NextAuth/i,
          /supabase.*auth/i, /createMiddlewareClient/i,
          /getToken/i, /verifyToken/i, /jwt/i, /updateSession/i,
        ]
        if (authPatterns.some(p => p.test(content))) {
          hasAuthMiddleware = true
          break
        }
      } catch {
        // File doesn't exist
      }
    }
  } catch {
    // No middleware
  }

  // Also check for rate limiting in middleware files if not already detected from deps
  if (!hasRateLimiting) {
    for (const name of ['middleware.ts', 'middleware.js', 'src/middleware.ts', 'src/middleware.js']) {
      try {
        const content = await readFile(resolve(root, name), 'utf-8')
        if (/rateLimit/i.test(content) || /throttle/i.test(content)) {
          hasRateLimiting = true
          break
        }
      } catch {
        // File doesn't exist
      }
    }
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

  return {
    root,
    packageJson,
    declaredDependencies,
    tsconfigPaths,
    hasAuthMiddleware,
    hasRateLimiting,
    detectedFrameworks,
    gitignoreContent,
    envInGitignore,
    allFiles: files,
  }
}
