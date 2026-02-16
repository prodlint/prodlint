import type { Rule, Finding, FileContext, ProjectContext } from '../types.js'
import { isCommentLine, NODE_BUILTINS } from '../utils/patterns.js'

// Packages that are commonly available without being in package.json
const IMPLICIT_PACKAGES = new Set([
  'react', 'react-dom', 'react/jsx-runtime', 'react/jsx-dev-runtime',
  'next', 'next/server', 'next/image', 'next/link', 'next/font',
  'next/navigation', 'next/headers', 'next/dynamic', 'next/script',
  'next/router', 'next/head', 'next/app', 'next/document',
])

// Line-level patterns to capture import sources
const LINE_IMPORT_PATTERNS = [
  /from\s+['"]([^'"./][^'"]*)['"]/,
  /require\s*\(\s*['"]([^'"./][^'"]*)['"]\s*\)/,
  /import\s*\(\s*['"]([^'"./][^'"]*)['"]\s*\)/,
]

function getPackageName(importPath: string): string {
  if (importPath.startsWith('@')) {
    const parts = importPath.split('/')
    return parts.slice(0, 2).join('/')
  }
  return importPath.split('/')[0]
}

function isNodeBuiltin(name: string): boolean {
  if (name.startsWith('node:')) return true
  return NODE_BUILTINS.has(name)
}

function isPathAlias(importPath: string, tsconfigPaths: Set<string>): boolean {
  // Common convention aliases
  if (importPath.startsWith('@/') || importPath === '@') return true
  if (importPath.startsWith('~/') || importPath.startsWith('#/')) return true

  // Check against tsconfig.json paths
  for (const prefix of tsconfigPaths) {
    if (importPath === prefix || importPath.startsWith(prefix + '/')) return true
  }

  return false
}

export const hallucinatedImportsRule: Rule = {
  id: 'hallucinated-imports',
  name: 'Hallucinated Imports',
  description: 'Detects imports of packages not declared in package.json and not Node.js built-ins',
  category: 'reliability',
  severity: 'critical',
  fileExtensions: ['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs'],

  check(file: FileContext, project: ProjectContext): Finding[] {
    if (!project.packageJson) return []

    const findings: Finding[] = []
    const seen = new Set<string>()

    for (let i = 0; i < file.lines.length; i++) {
      // Skip comments
      if (isCommentLine(file.lines, i, file.commentMap)) continue

      const line = file.lines[i]

      for (const pattern of LINE_IMPORT_PATTERNS) {
        const match = pattern.exec(line)
        if (!match) continue

        const importPath = match[1]
        const pkgName = getPackageName(importPath)

        if (seen.has(pkgName)) continue
        seen.add(pkgName)

        if (isPathAlias(importPath, project.tsconfigPaths)) continue
        if (isNodeBuiltin(pkgName)) continue
        if (IMPLICIT_PACKAGES.has(importPath) || IMPLICIT_PACKAGES.has(pkgName)) continue
        if (project.declaredDependencies.has(pkgName)) continue

        findings.push({
          ruleId: 'hallucinated-imports',
          file: file.relativePath,
          line: i + 1,
          column: match.index + 1,
          message: `Package "${pkgName}" is imported but not in package.json`,
          severity: 'critical',
          category: 'reliability',
        })
      }
    }

    return findings
  },
}
