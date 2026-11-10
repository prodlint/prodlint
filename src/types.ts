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

/** What the files of one package are judged by */
export interface PackageScope {
  /** Frameworks its package.json declares, with those of the packages above it, its workspace and the scanned packages it depends on */
  frameworks: Set<string>
  /** A rate-limiting package among those, or a rate limit in the root middleware */
  hasRateLimiting: boolean
}

export interface ProjectContext {
  root: string
  packageJson: Record<string, unknown> | null
  /** Every dependency and package name a package.json in the scanned tree declares */
  declaredDependencies: Set<string>
  tsconfigPaths: Set<string>
  hasAuthMiddleware: boolean
  /** The auth middleware's `config.matcher` keeps it off /api, so it doesn't cover API routes */
  authMiddlewareExcludesApi?: boolean
  /** The auth middleware's `config.matcher` keeps it on /api, so it doesn't cover the pages server actions are posted to */
  authMiddlewareExcludesPages?: boolean
  /** The root package's. A rule judging a file asks `packageOf()` for the file's own */
  hasRateLimiting: boolean
  /** middleware.ts or proxy.ts calls a rate limit and its matcher reaches pages, not just a rate-limiting package in the dependencies */
  rateLimitsInMiddleware?: boolean
  /** The root package's. A rule judging a file asks `packageOf()` for the file's own */
  detectedFrameworks: Set<string>
  /**
   * Every package.json's folder in the scanned tree ('' for the root, 'apps/web'), with what
   * its files are judged by. Read it through `packageOf()`, which finds a file's package
   */
  packageScopes?: Map<string, PackageScope>
  gitignoreContent: string | null
  envInGitignore: boolean
  allFiles: string[]
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
