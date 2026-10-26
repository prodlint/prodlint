import type { Rule, Finding, FileContext, ProjectContext } from '../types.js'
import { isTestFile, isScriptFile } from '../utils/patterns.js'

// Files that are entry points — their exports are consumed externally
function isEntryPoint(relativePath: string, appRoots: Set<string>): boolean {
  const name = relativePath.split('/').pop() ?? ''
  return /^(page|layout|loading|error|not-found|route|middleware|instrumentation|opengraph-image|twitter-image|icon|apple-icon|sitemap|robots|manifest)\.(tsx?|jsx?)$/.test(name) ||
    /^index\.(tsx?|jsx?)$/.test(name) ||
    name === 'global-error.tsx' ||
    name === 'global-error.jsx' ||
    isNextProxy(relativePath, appRoots)
}

// Next.js 16's middleware. Next.js runs it only from an app root or the root's src/, so the
// name is exempt only there. Elsewhere `proxy` is an ordinary module whose exports count,
// like the session helper in Supabase's lib/supabase/proxy.ts.
function isNextProxy(relativePath: string, appRoots: Set<string>): boolean {
  const match = /^(?:(.*)\/)?proxy\.(tsx?|jsx?)$/.exec(relativePath)
  if (!match) return false
  const dir = match[1] ?? ''
  return appRoots.has(dir) || appRoots.has(dir.replace(/(?:^|\/)src$/, ''))
}

/** The scanned root (`''`) and every folder with a package.json: where an app can live */
function findAppRoots(paths: string[]): Set<string> {
  const roots = new Set([''])
  for (const path of paths) {
    const match = /^(?:(.*)\/)?package\.json$/.exec(path)
    if (match) roots.add(match[1] ?? '')
  }
  return roots
}

const EXPORT_NAMED = /export\s+(?:async\s+)?(?:function|const|let|class|enum)\s+(\w+)/g
const EXPORT_DEFAULT = /export\s+default\s+(?:async\s+)?(?:function|class)\s+(\w+)/g
const EXPORT_BRACES = /export\s*\{([^}]+)\}/g
const DYNAMIC_IMPORT = /import\s*\(\s*['"`]([^'"`]+)['"`]\s*\)/g

// Imports are read from the whole file, so a statement can span lines:
// `import { a, b as c } from 'x'`, `import type { a } from 'x'`, `import D, { a } from 'x'`
const IMPORT_NAMED = /\bimport\s*(?:type\s*)?(?:[\w$]+\s*,\s*)?\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/g
// `import D from 'x'`, `import D, { a } from 'x'`
const IMPORT_DEFAULT = /\bimport\s+([\w$]+)\s*(?:,\s*\{[^}]*\}\s*)?from\s*['"]([^'"]+)['"]/g
// `import * as ns from 'x'`: any export of x may be used through ns
const IMPORT_NAMESPACE = /\bimport\s+(?:[\w$]+\s*,\s*)?\*\s*as\s+[\w$]+\s+from\s*['"]([^'"]+)['"]/g
const FROM_SOURCE = /from\s+['"]([^'"]+)['"]/g

/** `'@/lib/utils'` → `utils`, matching how export files are keyed */
function sourceBasename(source: string): string {
  return source.split('/').pop()?.replace(/\.\w+$/, '') ?? ''
}

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

  checkProject(files: FileContext[], project: ProjectContext): Finding[] {
    const sourceFiles = files.filter(f =>
      ['ts', 'tsx', 'js', 'jsx'].includes(f.ext) &&
      !isTestFile(f.relativePath) &&
      !isScriptFile(f.relativePath),
    )
    const appRoots = findAppRoots(project.allFiles)

    // Collect all exported symbols with their locations
    const exports = new Map<string, { file: string; line: number }>()
    // Collect imports keyed by from-clause basename → Set of symbol names
    const imports = new Map<string, Set<string>>()
    // Flat set of all imported symbol names (for files with no from-clause info)
    const allImportedSymbols = new Set<string>()
    // Track which files are imported (for default imports and dynamic imports)
    const importedFiles = new Set<string>()
    // Basenames imported as a namespace: all their exports count as used
    const namespaceImported = new Set<string>()

    for (const file of sourceFiles) {
      if (isEntryPoint(file.relativePath, appRoots)) continue

      // Collect named exports
      let inTemplateLiteral = false
      for (let i = 0; i < file.lines.length; i++) {
        const line = file.lines[i]

        // Track multiline template literal state (backtick toggles)
        let backtickCount = 0
        for (let j = 0; j < line.length; j++) {
          if (line[j] === '\\') { j++; continue }
          if (line[j] === '`') backtickCount++
        }
        if (backtickCount % 2 === 1) inTemplateLiteral = !inTemplateLiteral

        // Skip lines inside template literals (code examples containing 'export')
        if (inTemplateLiteral && backtickCount % 2 === 0) continue

        // Skip if 'export' is inside a string literal on this line
        const exportIdx = line.indexOf('export')
        if (exportIdx >= 0) {
          let inStr = false
          for (let j = 0; j < exportIdx; j++) {
            if (line[j] === '\\') { j++; continue }
            if (line[j] === "'" || line[j] === '"' || line[j] === '`') inStr = !inStr
          }
          if (inStr) continue
        }

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

    const addImport = (sym: string, source: string) => {
      allImportedSymbols.add(sym)
      const fromBasename = sourceBasename(source)
      if (fromBasename) {
        const set = imports.get(fromBasename) ?? new Set()
        set.add(sym)
        imports.set(fromBasename, set)
      }
    }

    // Collect all imports across ALL files (including tests — they consume exports)
    for (const file of files) {
      for (const match of file.content.matchAll(IMPORT_NAMED)) {
        const symbols = match[1]
          .replace(/\/\/.*$/gm, '')
          .replace(/\/\*[\s\S]*?\*\//g, '')
          .split(',')
          .map(s => s.trim().replace(/^type\s+/, '').split(/\s+as\s+/)[0].trim())
          .filter(Boolean)
        for (const sym of symbols) addImport(sym, match[2])
      }

      for (const match of file.content.matchAll(IMPORT_DEFAULT)) {
        addImport(match[1], match[2])
      }

      for (const match of file.content.matchAll(IMPORT_NAMESPACE)) {
        namespaceImported.add(sourceBasename(match[1]))
      }

      // Track file imports for re-export detection
      for (const match of file.content.matchAll(FROM_SOURCE)) {
        importedFiles.add(match[1])
      }
    }

    // Find dead exports — match import source basename against export file basename
    const deadByFile = new Map<string, number>()
    for (const [key, loc] of exports) {
      const symbolName = key.split('::')[1]
      const exportFileBasename = loc.file.split('/').pop()?.replace(/\.\w+$/, '') ?? ''
      if (namespaceImported.has(exportFileBasename)) continue

      // Check if any import from a matching basename includes this symbol
      const importSet = imports.get(exportFileBasename)
      const isImported = importSet?.has(symbolName) ?? false

      // Fallback: if symbol was imported without a traceable from-clause, count it
      if (!isImported && !allImportedSymbols.has(symbolName)) {
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
        fix: 'Remove the unused export or add a consumer',
      })
    }

    return findings
  },
}
