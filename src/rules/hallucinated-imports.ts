import type { Rule, Finding, FileContext, ProjectContext } from '../types.js'
import { NODE_BUILTINS } from '../utils/patterns.js'

// Packages that are commonly available without being in package.json
const IMPLICIT_PACKAGES = new Set([
  'react', 'react-dom', 'react/jsx-runtime', 'react/jsx-dev-runtime',
  // Next.js sub-packages
  'next', 'next/server', 'next/image', 'next/link', 'next/font',
  'next/navigation', 'next/headers', 'next/dynamic', 'next/script',
  'next/router', 'next/head', 'next/app', 'next/document',
])

// Line-level patterns to capture import sources (no cross-line matching)
const LINE_IMPORT_PATTERNS = [
  // import ... from 'pkg' (single-line)
  /from\s+['"]([^'"./][^'"]*)['"]/,
  // require('pkg')
  /require\s*\(\s*['"]([^'"./][^'"]*)['"]\s*\)/,
  // import('pkg') — dynamic
  /import\s*\(\s*['"]([^'"./][^'"]*)['"]\s*\)/,
]

function getPackageName(importPath: string): string {
  // @scope/pkg/sub → @scope/pkg
  if (importPath.startsWith('@')) {
    const parts = importPath.split('/')
    return parts.slice(0, 2).join('/')
  }
  // pkg/sub → pkg
  return importPath.split('/')[0]
}

function isNodeBuiltin(name: string): boolean {
  if (name.startsWith('node:')) return true
  return NODE_BUILTINS.has(name)
}

/**
 * Detect TypeScript/bundler path aliases like @/, ~/, #/
 * These are project-internal imports, not npm packages
 */
function isPathAlias(importPath: string): boolean {
  // @/ is the most common Next.js/TS alias
  if (importPath.startsWith('@/') || importPath === '@') return true
  // ~/ and #/ are also common aliases
  if (importPath.startsWith('~/') || importPath.startsWith('#/')) return true
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
    if (!project.packageJson) return [] // Can't check without package.json

    const findings: Finding[] = []
    const seen = new Set<string>() // Avoid duplicate findings per package

    for (let i = 0; i < file.lines.length; i++) {
      const line = file.lines[i]
      const trimmed = line.trim()

      // Skip comments
      if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) continue

      for (const pattern of LINE_IMPORT_PATTERNS) {
        const match = pattern.exec(line)
        if (!match) continue

        const importPath = match[1]
        const pkgName = getPackageName(importPath)

        if (seen.has(pkgName)) continue
        seen.add(pkgName)

        if (isPathAlias(importPath)) continue
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
