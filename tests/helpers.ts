import type { FileContext, ProjectContext } from '../src/types.js'
import { buildCommentMap } from '../src/utils/patterns.js'
import { parseFile } from '../src/utils/ast.js'

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
