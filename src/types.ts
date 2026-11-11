export type Severity = 'critical' | 'warning' | 'info'

export type Category = 'security' | 'reliability' | 'performance' | 'ai-quality'

export interface Finding {
  ruleId: string
  file: string
  line: number
  column: number
  message: string
  severity: Severity
  category: Category
  fix?: string
}

export interface FileContext {
  absolutePath: string
  relativePath: string
  content: string
  lines: string[]
  ext: string
  commentMap: boolean[]
  ast?: import('@babel/parser').ParseResult<import('@babel/types').File> | null
}

export interface ProjectContext {
  root: string
  packageJson: Record<string, unknown> | null
  declaredDependencies: Set<string>
  tsconfigPaths: Set<string>
  /**
   * Each folder of the scanned tree that has a tsconfig.json ('' for the root, 'apps/web'),
   * or a jsconfig.json and no tsconfig.json, with what its files' imports are judged by.
   * Read it through `tsconfigOf()`, which finds a file's config. `tsconfigPaths` is the root
   * config's `paths`, which apply to every file
   */
  tsconfigs?: Map<string, TsconfigScope>
  hasAuthMiddleware: boolean
  /** The auth middleware's `config.matcher` keeps it off /api, so it doesn't cover API routes */
  authMiddlewareExcludesApi?: boolean
  /** The auth middleware's `config.matcher` keeps it on /api, so it doesn't cover the pages server actions are posted to */
  authMiddlewareExcludesPages?: boolean
  hasRateLimiting: boolean
  /** middleware.ts or proxy.ts calls a rate limit and its matcher reaches pages, not just a rate-limiting package in the dependencies */
  rateLimitsInMiddleware?: boolean
  detectedFrameworks: Set<string>
  gitignoreContent: string | null
  envInGitignore: boolean
  allFiles: string[]
}

/** What the nearest tsconfig.json above a file says about the file's imports */
export interface TsconfigScope {
  /** The prefixes of its `paths`: `@components` for `@components/*` */
  paths: Set<string>
  /** The folder its `baseUrl` names, from the scanned root: '' for the root, 'apps/web/src'. null without one */
  baseUrl: string | null
  /** The folders directly under `baseUrl`: an import that starts with one is a path into it, not a package */
  baseUrlFolders: Set<string>
  /** What an import of one segment can name under `baseUrl`: a file, with or without its extension, or a folder with an index */
  baseUrlModules: Set<string>
}

export interface Rule {
  id: string
  name: string
  description: string
  category: Category
  severity: Severity
  fileExtensions: string[]
  check(file: FileContext, project: ProjectContext): Finding[]
  /** Optional project-level analysis after all per-file checks complete */
  checkProject?(files: FileContext[], project: ProjectContext): Finding[]
}

export interface CategoryScore {
  category: Category
  score: number
  findingCount: number
}

export interface ScanResult {
  version: string
  scannedPath: string
  filesScanned: number
  scanDurationMs: number
  findings: Finding[]
  overallScore: number
  categoryScores: CategoryScore[]
  summary: { critical: number; warning: number; info: number }
}

export interface ScanOptions {
  path: string
  ignore?: string[]
}
