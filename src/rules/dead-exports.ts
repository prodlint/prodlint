import type { Rule, Finding, FileContext, ProjectContext } from '../types.js'
import { isTestFile, isScriptFile, NODE_BUILTINS } from '../utils/patterns.js'

// Files that are entry points — their exports are consumed externally
function isEntryPoint(relativePath: string, appRoots: Set<string>): boolean {
  const name = relativePath.split('/').pop() ?? ''
  return /^(page|layout|loading|error|not-found|route|middleware|instrumentation|opengraph-image|twitter-image|icon|apple-icon|sitemap|robots|manifest)\.(tsx?|jsx?)$/.test(name) ||
    isBarrel(relativePath) ||
    name === 'global-error.tsx' ||
    name === 'global-error.jsx' ||
    // SvelteKit's route files: +page.ts, +page.server.ts, +layout.ts, +server.ts
    /^\+(page|layout|server)(\.server)?\.(ts|js)$/.test(name) ||
    isNextProxy(relativePath, appRoots) ||
    isPagesRoute(relativePath, appRoots)
}

/** An index file: its exports are skipped, but what it re-exports counts only when imported */
function isBarrel(relativePath: string): boolean {
  return /(?:^|\/)index\.(tsx?|jsx?)$/.test(relativePath)
}

/** An app root or its src/: where Next.js looks for its special files and folders */
function isAppFolder(dir: string, appRoots: Set<string>): boolean {
  return appRoots.has(dir) || appRoots.has(dir.replace(/(?:^|\/)src$/, ''))
}

// Next.js 16's middleware. Next.js runs it only from an app root or the root's src/, so the
// name is exempt only there. Elsewhere `proxy` is an ordinary module whose exports count,
// like the session helper in Supabase's lib/supabase/proxy.ts.
function isNextProxy(relativePath: string, appRoots: Set<string>): boolean {
  const match = /^(?:(.*)\/)?proxy\.(tsx?|jsx?)$/.exec(relativePath)
  return match !== null && isAppFolder(match[1] ?? '', appRoots)
}

// The Pages Router: every module under an app root's pages/ (or src/pages/) is a route. A
// pages/ folder anywhere else, like components/pages/, is an ordinary one.
function isPagesRoute(relativePath: string, appRoots: Set<string>): boolean {
  if (!/\.(tsx?|jsx?)$/.test(relativePath)) return false
  const parts = relativePath.split('/')
  return parts.some((part, i) => part === 'pages' && isAppFolder(parts.slice(0, i).join('/'), appRoots))
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

// Imports are read from the whole file, so a statement can span lines:
// `import { a, b as c } from 'x'`, `import type { a } from 'x'`, `import D, { a } from 'x'`
const IMPORT_NAMED = /\bimport\s*(?:type\s*)?(?:[\w$]+\s*,\s*)?\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/g
// `import D from 'x'`, `import D, { a } from 'x'`
const IMPORT_DEFAULT = /\bimport\s+([\w$]+)\s*(?:,\s*\{[^}]*\}\s*)?from\s*['"]([^'"]+)['"]/g
// `import * as ns from 'x'`: any export of x may be used through ns
const IMPORT_NAMESPACE = /\bimport\s+(?:[\w$]+\s*,\s*)?\*\s*as\s+[\w$]+\s+from\s*['"]([^'"]+)['"]/g
// `import('x')` loads the whole module, so it may use any export. `import('x').a` and
// `const { a } = await import('x')` use `a`; `typeof import('x')`, a type, uses none.
// Groups: typeof, the destructured names, the source, the member read
const DYNAMIC_IMPORT = /(\btypeof\s+)?(?:\{([^{}]*)\}\s*=\s*await\s+)?\bimport\s*\(\s*['"`]([^'"`]+)['"`]\s*\)(?:\s*\.\s*([\w$]+))?/g
// The same for `require('x')`. Groups: the destructured names, the source, the member read
const REQUIRE = /(?:\{([^{}]*)\}\s*=\s*)?\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)(?:\s*\.\s*([\w$]+))?/g
// `export { a, b as c } from 'x'`, `export type { a } from 'x'`
const REEXPORT_NAMED = /\bexport\s*(?:type\s*)?\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/g
// `export * from 'x'`, `export * as ns from 'x'`
const REEXPORT_ALL = /\bexport\s*\*\s*(?:as\s+([\w$]+)\s*)?from\s*['"]([^'"]+)['"]/g

const MODULE_EXTENSIONS = ['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs']
const MODULE_EXTENSION = /\.(?:[cm]?[jt]s|[jt]sx)$/

/** `a, b as c, type d` → `[['a', 'a'], ['b', 'c'], ['d', 'd']]`: each name and the name it's bound to */
function parseSpecifiers(list: string): [string, string][] {
  return list
    .replace(/\/\/.*$/gm, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split(',')
    .map(s => s.trim().replace(/^type\s+/, ''))
    .filter(Boolean)
    .map(s => {
      const [name, alias] = s.split(/\s+as\s+/).map(part => part.trim())
      return [name, alias ?? name]
    })
}

/** `lib/../app/./x` → `app/x`; null when the path climbs out of the scanned root */
function normalizePath(path: string): string | null {
  const parts: string[] = []
  for (const part of path.split('/')) {
    if (part === '..') {
      if (parts.length === 0) return null
      parts.pop()
    } else if (part && part !== '.') {
      parts.push(part)
    }
  }
  return parts.join('/')
}

// What an import loads. `files` are the scanned modules it resolves to; they pass a use on
// through their re-exports. In `folders`, a name it imports counts wherever it's exported:
// a workspace package's folder, or the scanned root ('') when no scanned file matches.
type Target = { files: string[]; folders: string[] }
const EXTERNAL: Target = { files: [], folders: [] } // an npm package, a Node built-in, a URL
const UNKNOWN: Target = { files: [], folders: [''] }

/** A source naming a stylesheet, image or data file: it has no exports to count */
function isAsset(source: string): boolean {
  const name = source.slice(source.lastIndexOf('/') + 1)
  // A name before the extension: .source, fumadocs' generated folder, is no file
  return /^[^.].*\.\w+$/.test(name) && !MODULE_EXTENSION.test(name)
}

/** Every string in a package.json field: `exports` nests them in subpaths and conditions */
function stringsIn(value: unknown): string[] {
  if (typeof value === 'string') return [value]
  if (Array.isArray(value)) return value.flatMap(stringsIn)
  if (value && typeof value === 'object') return Object.values(value).flatMap(stringsIn)
  return []
}

/**
 * Resolves an import's source, from the file that has the import, to what it loads. Also
 * finds the entry points of the scan's published packages
 */
function createResolver(files: FileContext[], project: ProjectContext): {
  resolve: (source: string, from: string) => Target
  packageEntries: Set<string>
} {
  const modules = new Set(files.filter(f => MODULE_EXTENSIONS.includes(f.ext)).map(f => f.relativePath))

  // Modules by the last segment of their extensionless path, for alias imports. A folder's
  // index is listed under the folder: `@/lib` loads lib/index.ts
  const byName = new Map<string, { path: string; key: string }[]>()
  for (const path of modules) {
    const key = path.replace(/\.\w+$/, '').replace(/(?:^|\/)index$/, '')
    const name = key.slice(key.lastIndexOf('/') + 1)
    const list = byName.get(name)
    if (list) list.push({ path, key })
    else byName.set(name, [{ path, key }])
  }

  const manifests: { folder: string; json: Record<string, unknown> }[] = []
  for (const file of files) {
    if (!/(?:^|\/)package\.json$/.test(file.relativePath)) continue
    try {
      const json = JSON.parse(file.content)
      if (json && typeof json === 'object') manifests.push({ folder: file.relativePath.replace(/\/?package\.json$/, ''), json })
    } catch {
      // Not valid JSON
    }
  }

  // Workspace packages by name, with the folders they're in
  const packages = new Map<string, string[]>()
  for (const { folder, json } of manifests) {
    if (typeof json.name === 'string' && json.name) packages.set(json.name, [...(packages.get(json.name) ?? []), folder])
  }

  /** `lib/format` → the module a bundler loads for it: lib/format.ts, lib/format/index.tsx, … */
  const findModule = (path: string): string | undefined => {
    const stem = path.replace(/\.(?:[cm]?js|jsx)$/, '')
    const index = path ? `${path}/index` : 'index'
    return [
      path,
      // TypeScript's ESM style names the compiled file: ./format.js for format.ts
      ...(stem === path ? [] : [`${stem}.ts`, `${stem}.tsx`]),
      ...MODULE_EXTENSIONS.map(ext => `${path}.${ext}`),
      ...MODULE_EXTENSIONS.map(ext => `${index}.${ext}`),
    ].find(candidate => modules.has(candidate))
  }

  // A published package's entry points (main, module, exports, bin): whoever installs the
  // package uses their exports. It names JavaScript or its .d.ts, which a build may compile
  // from src/, so dist/index.js can stand for src/index.ts. A package that isn't private
  // but names TypeScript source is a workspace's own, used only through its imports
  const packageEntries = new Set<string>()
  for (const { folder, json } of manifests) {
    if (json.private === true) continue
    for (const target of stringsIn([json.main, json.module, json.types, json.typings, json.exports, json.bin])) {
      const isSource = /\.(?:[cm]?ts|tsx)$/.test(target) && !/\.d\.[cm]?ts$/.test(target)
      const path = isSource || target.includes('*') ? null : normalizePath(`${folder}/${target}`)
      if (path === null) continue
      const stem = path.replace(/\.d\.ts$/, '').replace(MODULE_EXTENSION, '')
      const entry = findModule(path) ?? findModule(stem) ??
        findModule(stem.replace(/(^|\/)(?:dist|build|lib|out|esm|cjs)\//, '$1src/'))
      if (entry) packageEntries.add(entry)
    }
  }

  const resolveRelative = (path: string): Target => {
    const normalized = normalizePath(path)
    if (normalized?.includes('${')) {
      // import(`./locale/${lang}`): a bundler includes every module that fits the pattern
      const parts = normalized.split(/\$\{[^}]*\}/).map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      const pattern = new RegExp(`^${parts.join('.*')}(?:\\.\\w+)?$`)
      return { files: [...modules].filter(m => pattern.test(m)), folders: [] }
    }
    const module = normalized === null ? undefined : findModule(normalized)
    if (module) return { files: [module], folders: [] }
    // Any other miss may be a module the scan doesn't have
    return isAsset(path) ? EXTERNAL : UNKNOWN
  }

  const resolveBare = (source: string): Target => {
    // node:fs, npm:zod, https://esm.sh/…
    if (/^[a-z][\w+.-]*:/i.test(source)) return EXTERNAL
    const name = source.startsWith('@') ? source.split('/').slice(0, 2).join('/') : source.split('/')[0]
    const folders = packages.get(name)
    if (folders) {
      // A workspace package: its module at that subpath, or its index. Its names also count
      // anywhere in the package, in case the import resolves some other way
      const subpath = source.slice(name.length + 1)
      const found = folders.map(folder => {
        const base = folder ? `${folder}/` : ''
        return subpath
          ? findModule(base + subpath) ?? findModule(`${base}src/${subpath}`)
          : findModule(folder) ?? findModule(`${base}src`)
      })
      return { files: found.filter((f): f is string => f !== undefined), folders }
    }
    if (NODE_BUILTINS.has(name) || project.declaredDependencies.has(name)) return EXTERNAL
    // An alias (@/lib/utils, ~/lib/utils, a tsconfig path) or a baseUrl import: the modules
    // whose path ends with as much of the import's path as any module's does. The first
    // segment may be the alias itself (@, ~, @components); past it, a module that matches
    // only by file name may be another file of that name, so the import stays unknown
    const segments = source.replace(MODULE_EXTENSION, '').split('/').filter(Boolean)
    const named = byName.get(segments[segments.length - 1] ?? '') ?? []
    for (let i = 0; i < segments.length; i++) {
      const path = segments.slice(i).join('/')
      const matches = named.filter(m => m.key === path || m.key.endsWith(`/${path}`))
      if (matches.length > 0) return i <= 1 ? { files: matches.map(m => m.path), folders: [] } : UNKNOWN
    }
    return isAsset(source) ? EXTERNAL : UNKNOWN
  }

  const cache = new Map<string, Target>()
  const resolve = (source: string, from: string): Target => {
    // Vite's ./worker?worker and ./icon.svg?react
    const clean = source.replace(/\?.*$/, '')
    // ./x, ../x, . and .., but not .prisma/client, which names a package
    const relative = /^\.\.?(?:\/|$)/.test(clean)
    const dir = relative ? from.slice(0, from.lastIndexOf('/') + 1) : ''
    const key = `${dir}\0${clean}`
    let target = cache.get(key)
    if (!target) {
      target = relative ? resolveRelative(dir + clean) : resolveBare(clean)
      cache.set(key, target)
    }
    return target
  }

  return { resolve, packageEntries }
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
    const { resolve, packageEntries } = createResolver(files, project)

    // Collect all exported symbols with their locations
    const exports = new Map<string, { file: string; line: number }>()

    for (const file of sourceFiles) {
      if (isEntryPoint(file.relativePath, appRoots) || packageEntries.has(file.relativePath)) continue

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

    const contents = new Map(files.map(f => [f.relativePath, f.content]))

    // Exports something imports, as `file::name`; `file::*` means every export of the file
    const used = new Set<string>()
    // Names that count wherever they're exported in a folder (see Target)
    const usedInFolder = new Map<string, Set<string>>()

    // A module's re-exports, read the first time something imports from it. `exported: '*'`
    // is `export * from`, which passes on every name but default
    const reexports = new Map<string, { source: string; imported: string; exported: string }[]>()
    const reexportsOf = (file: string) => {
      let list = reexports.get(file)
      if (!list) {
        list = []
        const content = contents.get(file) ?? ''
        for (const match of content.matchAll(REEXPORT_NAMED)) {
          for (const [imported, exported] of parseSpecifiers(match[1])) list.push({ source: match[2], imported, exported })
        }
        for (const match of content.matchAll(REEXPORT_ALL)) {
          list.push(match[1] ? { source: match[2], imported: '*', exported: match[1] } : { source: match[2], imported: '', exported: '*' })
        }
        reexports.set(file, list)
      }
      return list
    }

    // Marks export `name` ('*' for all of them) of what `target` loads as used. A module that
    // re-exports it passes the use on to the module it re-exports from
    const use = (target: Target, name: string) => {
      // A namespace or default import has no name to match exports by
      if (name !== '*' && name !== 'default') {
        for (const folder of target.folders) {
          const names = usedInFolder.get(folder) ?? new Set()
          names.add(name)
          usedInFolder.set(folder, names)
        }
      }
      for (const file of target.files) {
        const key = `${file}::${name}`
        if (used.has(key)) continue // also stops at a cycle of re-exports
        used.add(key)
        for (const { source, imported, exported } of reexportsOf(file)) {
          if (exported === '*') {
            if (name !== 'default') use(resolve(source, file), name)
          } else if (name === '*' || name === exported) {
            use(resolve(source, file), imported)
          }
        }
      }
    }

    // What a module loaded by import() or require() uses of it: the member read or the names
    // destructured, if the code names them, or else any export
    const useLoaded = (target: Target, destructured: string | undefined, member: string | undefined, typeOnly: boolean) => {
      if (member && !['then', 'catch', 'finally'].includes(member)) {
        use(target, member)
      } else if (typeOnly) {
        return
      } else if (destructured !== undefined && !destructured.includes('...')) {
        // `{ a, b: c, d = 1 }` → a, b, d
        for (const name of destructured.split(',').map(s => s.split(/[:=]/)[0].trim()).filter(Boolean)) use(target, name)
      } else {
        use(target, '*')
      }
    }

    // Collect all imports across ALL files (including tests — they consume exports)
    for (const file of files) {
      const from = file.relativePath
      for (const match of file.content.matchAll(IMPORT_NAMED)) {
        for (const [name] of parseSpecifiers(match[1])) use(resolve(match[2], from), name)
      }

      for (const match of file.content.matchAll(IMPORT_DEFAULT)) {
        // Also by its local name: `export const Chart = …` often comes with `export default Chart`
        const target = resolve(match[2], from)
        use(target, 'default')
        use(target, match[1])
      }

      for (const match of file.content.matchAll(IMPORT_NAMESPACE)) use(resolve(match[1], from), '*')

      for (const match of file.content.matchAll(DYNAMIC_IMPORT)) {
        const [, typeOnly, destructured, source, member] = match
        useLoaded(resolve(source, from), destructured, member, Boolean(typeOnly))
      }

      for (const match of file.content.matchAll(REQUIRE)) {
        const [, destructured, source, member] = match
        useLoaded(resolve(source, from), destructured, member, false)
      }

      // Next.js imports an entry point's exports itself, re-exports included
      if (isEntryPoint(from, appRoots) && !isBarrel(from)) use({ files: [from], folders: [] }, '*')
    }

    // So does whoever installs a published package
    for (const entry of packageEntries) use({ files: [entry], folders: [] }, '*')

    const usedInAFolderOf = (file: string, name: string): boolean => {
      let folder = file
      while (folder) {
        folder = folder.slice(0, Math.max(folder.lastIndexOf('/'), 0))
        if (usedInFolder.get(folder)?.has(name)) return true
      }
      return false
    }

    const deadByFile = new Map<string, number>()
    for (const [key, loc] of exports) {
      const symbolName = key.split('::')[1]
      const isUsed = used.has(key) || used.has(`${loc.file}::*`) || usedInAFolderOf(loc.file, symbolName)
      if (!isUsed) {
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
