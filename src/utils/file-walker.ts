import fg from 'fast-glob'
import { readFile, stat } from 'node:fs/promises'
import { resolve, extname } from 'node:path'
import { buildCommentMap } from './patterns.js'
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
  'json',
]

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
  })

  return files.sort()
}

export async function readFileContext(
  root: string,
  relativePath: string,
): Promise<FileContext | null> {
  try {
    const absolutePath = resolve(root, relativePath)

    // Skip files over 1MB
    const fileStats = await stat(absolutePath)
    if (fileStats.size > MAX_FILE_SIZE) return null

    const content = await readFile(absolutePath, 'utf-8')
    const lines = content.split('\n')
    return {
      absolutePath,
      relativePath,
      content,
      lines,
      ext: extname(relativePath).slice(1), // remove leading dot
      commentMap: buildCommentMap(lines),
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
    gitignoreContent,
    envInGitignore,
    allFiles: files,
  }
}
