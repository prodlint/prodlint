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

/**
 * Detect workspace patterns from package.json and pnpm-workspace.yaml.
 */
async function getWorkspacePatterns(root: string, packageJson: Record<string, unknown> | null): Promise<string[]> {
  const patterns: string[] = []

  // npm/yarn: "workspaces" field in package.json
  if (packageJson) {
    const workspaces = packageJson.workspaces
    if (Array.isArray(workspaces)) {
      patterns.push(...workspaces)
    } else if (workspaces && typeof workspaces === 'object' && Array.isArray((workspaces as any).packages)) {
      patterns.push(...(workspaces as any).packages)
    }
  }

  // pnpm: pnpm-workspace.yaml
  try {
    const raw = await readFile(resolve(root, 'pnpm-workspace.yaml'), 'utf-8')
    let inPackages = false
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim()
      if (/^packages\s*:/.test(trimmed)) {
        inPackages = true
        continue
      }
      if (inPackages) {
        if (/^-\s+/.test(trimmed)) {
          const glob = trimmed.replace(/^-\s+/, '').replace(/^['"]|['"]$/g, '')
          if (glob) patterns.push(glob)
        } else if (trimmed && !trimmed.startsWith('#')) {
          break // new top-level key
        }
      }
    }
  } catch {
    // No pnpm-workspace.yaml
  }

  return patterns
}

/**
 * Collect workspace package names and their dependencies.
 */
async function collectWorkspaceDependencies(root: string, patterns: string[]): Promise<Set<string>> {
  const deps = new Set<string>()
  const globPatterns = patterns.map(p => `${p}/package.json`)

  try {
    const pkgFiles = await fg(globPatterns, {
      cwd: root,
      absolute: false,
      ignore: ['**/node_modules/**'],
    })

    for (const pkgFile of pkgFiles) {
      try {
        const raw = await readFile(resolve(root, pkgFile), 'utf-8')
        const pkg = JSON.parse(raw)
        // Add workspace package name (importable by other workspace packages)
        if (pkg.name) deps.add(pkg.name)
        // Merge dependencies
        for (const key of ['dependencies', 'devDependencies', 'peerDependencies']) {
          if (pkg[key] && typeof pkg[key] === 'object') {
            for (const dep of Object.keys(pkg[key])) {
              deps.add(dep)
            }
          }
        }
      } catch {
        // Invalid package.json in workspace
      }
    }
  } catch {
    // Glob failed
  }

  return deps
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
  } catch {
    // No package.json or invalid JSON
  }

  // Monorepo workspace support: merge workspace deps
  const workspacePatterns = await getWorkspacePatterns(root, packageJson)
  if (workspacePatterns.length > 0) {
    const workspaceDeps = await collectWorkspaceDependencies(root, workspacePatterns)
    for (const dep of workspaceDeps) {
      declaredDependencies.add(dep)
    }
  }

  // Detect frameworks from dependencies (after workspace merging)
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
