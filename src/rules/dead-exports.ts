import type { Rule, Finding, FileContext, ProjectContext } from '../types.js'
import { isTestFile, isScriptFile } from '../utils/patterns.js'

// Files that are entry points — their exports are consumed externally
function isEntryPoint(relativePath: string): boolean {
  const name = relativePath.split('/').pop() ?? ''
  return /^(page|layout|loading|error|not-found|route|middleware|instrumentation)\.(tsx?|jsx?)$/.test(name) ||
    /^index\.(tsx?|jsx?)$/.test(name) ||
    name === 'global-error.tsx' ||
    name === 'global-error.jsx'
}

const EXPORT_NAMED = /export\s+(?:async\s+)?(?:function|const|let|class|enum)\s+(\w+)/g
const EXPORT_DEFAULT = /export\s+default\s+(?:async\s+)?(?:function|class)\s+(\w+)/g
const EXPORT_BRACES = /export\s*\{([^}]+)\}/g
const IMPORT_BRACES = /import\s*\{([^}]+)\}\s*from/g
const IMPORT_DEFAULT = /import\s+(\w+)\s+from/g
const DYNAMIC_IMPORT = /import\s*\(\s*['"`]([^'"`]+)['"`]\s*\)/g

const THRESHOLD = 5

export const deadExportsRule: Rule = {
  id: 'dead-exports',
  name: 'Dead Exports',
  description: 'Detects exported symbols never imported anywhere in the project — context pollution for AI tools',
  category: 'ai-quality',
  severity: 'info',
  fileExtensions: [],

  check(): Finding[] {
    return []
  },

  checkProject(files: FileContext[], _project: ProjectContext): Finding[] {
    const sourceFiles = files.filter(f =>
      ['ts', 'tsx', 'js', 'jsx'].includes(f.ext) &&
      !isTestFile(f.relativePath) &&
      !isScriptFile(f.relativePath),
    )

    // Collect all exported symbols with their locations
    const exports = new Map<string, { file: string; line: number }>()
    // Collect all imported symbols
    const imports = new Set<string>()
    // Track which files are imported (for default imports and dynamic imports)
    const importedFiles = new Set<string>()

    for (const file of sourceFiles) {
      if (isEntryPoint(file.relativePath)) continue

      // Collect named exports
      for (let i = 0; i < file.lines.length; i++) {
        const line = file.lines[i]

        let match
        const namedRe = /export\s+(?:async\s+)?(?:function|const|let|class|enum)\s+(\w+)/g
        while ((match = namedRe.exec(line)) !== null) {
          // Skip type/interface exports — they're stripped at compile time
          if (/export\s+(type|interface)\s/.test(line)) continue
          exports.set(`${file.relativePath}::${match[1]}`, { file: file.relativePath, line: i + 1 })
        }

        const braceRe = /export\s*\{([^}]+)\}/g
        while ((match = braceRe.exec(line)) !== null) {
          const symbols = match[1].split(',').map(s => s.trim().split(/\s+as\s+/).pop()?.trim()).filter(Boolean)
          for (const sym of symbols) {
            if (sym) exports.set(`${file.relativePath}::${sym}`, { file: file.relativePath, line: i + 1 })
          }
        }
      }
    }

    // Collect all imports across ALL files (including tests — they consume exports)
    for (const file of files) {
      for (const line of file.lines) {
        let match

        const bracesRe = /import\s*(?:type\s*)?\{([^}]+)\}\s*from/g
        while ((match = bracesRe.exec(line)) !== null) {
          const symbols = match[1].split(',').map(s => s.trim().split(/\s+as\s+/)[0].trim()).filter(Boolean)
          for (const sym of symbols) imports.add(sym)
        }

        const defaultRe = /import\s+(\w+)\s+from/g
        while ((match = defaultRe.exec(line)) !== null) {
          imports.add(match[1])
        }

        // Track file imports for re-export detection
        const fromRe = /from\s+['"]([^'"]+)['"]/g
        while ((match = fromRe.exec(line)) !== null) {
          importedFiles.add(match[1])
        }
      }
    }

    // Find dead exports
    const deadByFile = new Map<string, number>()
    for (const [key, loc] of exports) {
      const symbolName = key.split('::')[1]
      if (!imports.has(symbolName)) {
        deadByFile.set(loc.file, (deadByFile.get(loc.file) ?? 0) + 1)
      }
    }

    const findings: Finding[] = []
    let totalDead = 0
    for (const [file, count] of deadByFile) {
      totalDead += count
    }

    if (totalDead >= THRESHOLD) {
      // Find the top offending files
      const topFiles = [...deadByFile.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([f, c]) => `${f} (${c})`)

      findings.push({
        ruleId: 'dead-exports',
        file: '(project)',
        line: 1,
        column: 1,
        message: `${totalDead} exported symbols never imported — dead exports pollute AI context. Top files: ${topFiles.join(', ')}`,
        severity: totalDead > 20 ? 'warning' : 'info',
        category: 'ai-quality',
      })
    }

    return findings
  },
}
