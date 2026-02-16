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
}

export interface FileContext {
  absolutePath: string
  relativePath: string
  content: string
  lines: string[]
  ext: string
}

export interface ProjectContext {
  root: string
  packageJson: Record<string, unknown> | null
  declaredDependencies: Set<string>
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
  json?: boolean
  ignore?: string[]
}
