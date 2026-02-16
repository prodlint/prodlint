import fg from 'fast-glob'
import { readFile } from 'node:fs/promises'
import { resolve, relative, extname } from 'node:path'
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
  'json', 'env', 'env.*',
]

export async function walkFiles(
  root: string,
  extraIgnores: string[] = [],
): Promise<string[]> {
  const patterns = SCAN_EXTENSIONS.map(ext => `**/*.${ext}`)
  // Also grab .env files (no extension pattern)
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
    const content = await readFile(absolutePath, 'utf-8')
    return {
      absolutePath,
      relativePath,
      content,
      lines: content.split('\n'),
      ext: extname(relativePath).slice(1), // remove leading dot
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
    // No package.json
  }

  // Read .gitignore
  try {
    gitignoreContent = await readFile(resolve(root, '.gitignore'), 'utf-8')
    envInGitignore = /^\.env$/m.test(gitignoreContent) ||
      /^\.env\.\*$/m.test(gitignoreContent) ||
      /^\.env\.local$/m.test(gitignoreContent)
  } catch {
    // No .gitignore
  }

  return {
    root,
    packageJson,
    declaredDependencies,
    gitignoreContent,
    envInGitignore,
    allFiles: files,
  }
}
