import type { Rule, Finding, FileContext, ProjectContext } from '../types.js'
import { isTestFile, isScriptFile, isConfigFile } from '../utils/patterns.js'

interface DimensionTally {
  label: string
  variants: Map<string, string[]> // variant name → files using it
}

function tallyDimension(label: string, files: FileContext[], detector: (f: FileContext) => string | null): DimensionTally {
  const variants = new Map<string, string[]>()
  for (const file of files) {
    const variant = detector(file)
    if (variant) {
      const list = variants.get(variant) ?? []
      list.push(file.relativePath)
      variants.set(variant, list)
    }
  }
  return { label, variants }
}

function detectNamingConvention(file: FileContext): string | null {
  let camel = 0
  let snake = 0
  for (const line of file.lines) {
    // exported function/const names
    const match = line.match(/export\s+(?:function|const|let)\s+(\w+)/)
    if (match) {
      const name = match[1]
      if (/[a-z][A-Z]/.test(name)) camel++
      else if (/_[a-z]/.test(name)) snake++
    }
  }
  if (camel > 0 && snake === 0) return 'camelCase'
  if (snake > 0 && camel === 0) return 'snake_case'
  if (camel > 0 && snake > 0) return 'mixed'
  return null
}

function detectImportStyle(file: FileContext): string | null {
  let esm = 0
  let cjs = 0
  for (const line of file.lines) {
    if (/^\s*import\s+/.test(line)) esm++
    if (/\brequire\s*\(/.test(line)) cjs++
  }
  if (esm > 0 && cjs === 0) return 'ESM import'
  if (cjs > 0 && esm === 0) return 'CJS require'
  if (esm > 0 && cjs > 0) return 'mixed'
  return null
}

function detectHttpClient(file: FileContext): string | null {
  const content = file.content
  if (/\baxios[\s.(]/.test(content)) return 'axios'
  if (/\bgot[\s.(]/.test(content) && /from\s+['"]got['"]/.test(content)) return 'got'
  if (/\bky[\s.(]/.test(content) && /from\s+['"]ky['"]/.test(content)) return 'ky'
  if (/\bfetch\s*\(/.test(content)) return 'fetch'
  return null
}

function detectAsyncPattern(file: FileContext): string | null {
  let awaits = 0
  let thens = 0
  let callbacks = 0
  for (const line of file.lines) {
    if (/\bawait\b/.test(line)) awaits++
    if (/\.then\s*\(/.test(line)) thens++
    if (/,\s*(?:function\s*\(|(?:err|error|cb|callback)\s*=>)/.test(line)) callbacks++
  }
  const total = awaits + thens + callbacks
  if (total === 0) return null
  if (awaits > 0 && thens === 0 && callbacks === 0) return 'async/await'
  if (thens > 0 && awaits === 0) return '.then() chains'
  if (callbacks > 0 && awaits === 0 && thens === 0) return 'callbacks'
  if (awaits > 0 && thens > 0) return 'mixed async'
  return null
}

function detectQuoteStyle(file: FileContext): string | null {
  let single = 0
  let double = 0
  for (const line of file.lines) {
    const imports = line.match(/from\s+(['"])/g)
    if (imports) {
      for (const m of imports) {
        if (m.includes("'")) single++
        else double++
      }
    }
  }
  if (single > 0 && double === 0) return 'single quotes'
  if (double > 0 && single === 0) return 'double quotes'
  if (single > 0 && double > 0) return 'mixed quotes'
  return null
}

export const codebaseConsistencyRule: Rule = {
  id: 'codebase-consistency',
  name: 'Codebase Consistency',
  description: 'Detects conflicting conventions across files — naming, imports, async patterns, HTTP clients',
  category: 'ai-quality',
  severity: 'info',
  fileExtensions: [],

  check(): Finding[] {
    return [] // all analysis happens in checkProject
  },

  checkProject(files: FileContext[], _project: ProjectContext): Finding[] {
    const sourceFiles = files.filter(f =>
      ['ts', 'tsx', 'js', 'jsx'].includes(f.ext) &&
      !isTestFile(f.relativePath) &&
      !isScriptFile(f.relativePath) &&
      !isConfigFile(f.relativePath),
    )

    if (sourceFiles.length < 3) return []

    const dimensions = [
      tallyDimension('Naming convention', sourceFiles, detectNamingConvention),
      tallyDimension('Import style', sourceFiles, detectImportStyle),
      tallyDimension('HTTP client', sourceFiles, detectHttpClient),
      tallyDimension('Async pattern', sourceFiles, detectAsyncPattern),
      tallyDimension('Quote style', sourceFiles, detectQuoteStyle),
    ]

    const findings: Finding[] = []

    for (const dim of dimensions) {
      if (dim.variants.size < 2) continue

      // Find dominant vs minority
      let total = 0
      let dominant = ''
      let dominantCount = 0
      for (const [variant, fileList] of dim.variants) {
        total += fileList.length
        if (fileList.length > dominantCount) {
          dominantCount = fileList.length
          dominant = variant
        }
      }

      const consistency = Math.round((dominantCount / total) * 100)
      if (consistency >= 90) continue // 90%+ is fine

      const minorities: string[] = []
      for (const [variant, fileList] of dim.variants) {
        if (variant !== dominant) {
          minorities.push(`${variant} (${fileList.length} files)`)
        }
      }

      findings.push({
        ruleId: 'codebase-consistency',
        file: '(project)',
        line: 1,
        column: 1,
        message: `${dim.label}: ${consistency}% consistent — dominant: ${dominant} (${dominantCount} files), minority: ${minorities.join(', ')}`,
        severity: consistency < 60 ? 'warning' : 'info',
        category: 'ai-quality',
      })
    }

    return findings
  },
}
