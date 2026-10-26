import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import type { FileContext, ProjectContext, ScanResult } from '../src/types.js'
import { buildCommentMap } from '../src/utils/patterns.js'
import { parseFile } from '../src/utils/ast.js'
import { scan } from '../src/scanner.js'

/**
 * Create a FileContext from source code for testing rules.
 * By default, also parses the AST (pass withAst: false to skip).
 */
export function makeFile(
  code: string,
  opts: { relativePath?: string; ext?: string; withAst?: boolean } = {},
): FileContext {
  const lines = code.split('\n')
  const relativePath = opts.relativePath ?? 'test.ts'
  const ext = opts.ext ?? relativePath.split('.').pop() ?? 'ts'
  const shouldParseAst = opts.withAst !== false
  const astExtensions = new Set(['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs'])

  return {
    absolutePath: `/project/${relativePath}`,
    relativePath,
    content: code,
    lines,
    ext,
    commentMap: buildCommentMap(lines),
    ast: shouldParseAst && astExtensions.has(ext) ? parseFile(code, relativePath) : undefined,
  }
}

/**
 * Create a default ProjectContext for testing.
 */
export function makeProject(
  overrides: Partial<ProjectContext> = {},
): ProjectContext {
  return {
    root: '/project',
    packageJson: {},
    declaredDependencies: new Set(),
    tsconfigPaths: new Set(),
    hasAuthMiddleware: false,
    hasRateLimiting: false,
    detectedFrameworks: new Set(),
    gitignoreContent: null,
    envInGitignore: true,
    allFiles: [],
    ...overrides,
  }
}

/**
 * Write `files` (relative path → content) to a temporary project and scan it, so a test
 * goes through the scanner itself: file discovery, extensions, both phases, suppression.
 */
export async function scanFiles(files: Record<string, string>): Promise<ScanResult> {
  const dir = mkdtempSync(join(tmpdir(), 'prodlint-scan-'))
  try {
    for (const [relativePath, content] of Object.entries(files)) {
      const full = join(dir, relativePath)
      mkdirSync(dirname(full), { recursive: true })
      writeFileSync(full, content)
    }
    return await scan({ path: dir })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}
