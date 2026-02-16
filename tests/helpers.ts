import type { FileContext, ProjectContext } from '../src/types.js'
import { buildCommentMap } from '../src/utils/patterns.js'

/**
 * Create a FileContext from source code for testing rules.
 */
export function makeFile(
  code: string,
  opts: { relativePath?: string; ext?: string } = {},
): FileContext {
  const lines = code.split('\n')
  const ext = opts.ext ?? opts.relativePath?.split('.').pop() ?? 'ts'
  return {
    absolutePath: `/project/${opts.relativePath ?? 'test.ts'}`,
    relativePath: opts.relativePath ?? 'test.ts',
    content: code,
    lines,
    ext,
    commentMap: buildCommentMap(lines),
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
    gitignoreContent: null,
    envInGitignore: true,
    allFiles: [],
    ...overrides,
  }
}
