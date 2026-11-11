import { readFile, readdir, stat } from 'node:fs/promises'
import { resolve, posix } from 'node:path'
import type { ProjectContext, TsconfigScope } from '../types.js'

// A file's config is the tsconfig.json nearest above it, or the jsconfig.json of a folder
// that has no tsconfig.json: the same options for a JavaScript project
const CONFIG_NAMES = ['tsconfig.json', 'jsconfig.json']
const CONFIG_FILE = /(?:^|\/)[tj]sconfig\.json$/

const MAX_CONFIG_SIZE = 1024 * 1024 // 1MB, the scanner's limit for any file

// The extensions TypeScript adds to an import that has none: 'main' is main.ts, and a
// folder is its index
const MODULE_EXTENSION = /(?:\.d)?\.[cm]?[jt]s$|\.[jt]sx$/
const INDEX_FILE = /^index(?:\.d)?\.[cm]?[jt]s$|^index\.[jt]sx$/

/**
 * Parses JSON as TypeScript reads a tsconfig.json: `//` and block comments, trailing commas
 * and a byte order mark are allowed. Throws on anything else that isn't JSON.
 */
export function parseJsonc(text: string): unknown {
  let json = ''
  // A comma waits for what follows it: before a `}` or a `]` it's a trailing one
  let comma = false
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0

  while (i < text.length) {
    const char = text[i]
    if (char === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n' && text[i] !== '\r') i++
    } else if (char === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2)
      i = end === -1 ? text.length : end + 2
    } else if (char === ',') {
      if (comma) json += ','
      comma = true
      i++
    } else if (char === ' ' || char === '\t' || char === '\n' || char === '\r') {
      json += char
      i++
    } else {
      if (comma && char !== '}' && char !== ']') json += ','
      comma = false
      if (char === '"') {
        // A string, whole: `//` in "https://json.schemastore.org/tsconfig" starts no comment
        const start = i++
        while (i < text.length && text[i] !== '"') i += text[i] === '\\' ? 2 : 1
        json += text.slice(start, ++i)
      } else {
        json += char
        i++
      }
    }
  }

  return JSON.parse(json)
}

/** What one config file sets itself, before what it extends */
interface ConfigFile {
  /** The folder its `baseUrl` names, from the scanned root; null without one, or with one outside the root */
  baseUrl: string | null
  /** The prefixes of its `paths`; null without any, which leaves them to what it extends */
  paths: Set<string> | null
  /** The config files it extends by a relative path inside the scanned root */
  parents: string[]
}

/** `apps/web/tsconfig.json` → `apps/web`, and the root's is '' */
function folderOf(file: string): string {
  const folder = posix.dirname(file)
  return folder === '.' ? '' : folder
}

/**
 * A path a config names, from the scanned root. null when it leaves the root, or has
 * TypeScript 5.5's ${configDir} in it, which isn't the folder of the config that says it
 */
function fromRoot(folder: string, path: string): string | null {
  const relative = path.replace(/\\/g, '/')
  if (relative.startsWith('/') || /^[a-zA-Z]:/.test(relative) || relative.includes('${')) return null
  const joined = posix.normalize(posix.join(folder, relative)).replace(/\/$/, '')
  if (joined === '..' || joined.startsWith('../')) return null
  return joined === '.' ? '' : joined
}

async function readConfigFile(root: string, file: string): Promise<ConfigFile | null> {
  let raw: string
  try {
    // `file` is a scanned path, or one fromRoot() kept inside the scanned root
    const absolute = resolve(root, file)
    if ((await stat(absolute)).size > MAX_CONFIG_SIZE) return null
    raw = await readFile(absolute, 'utf-8')
  } catch {
    return null // No such file
  }

  const config: ConfigFile = { baseUrl: null, paths: null, parents: [] }
  let json: any
  try {
    json = parseJsonc(raw)
  } catch {
    return config // Not a config TypeScript can read either: it sets nothing
  }
  if (!json || typeof json !== 'object') return config
  const folder = folderOf(file)

  const options = json.compilerOptions ?? {}
  if (typeof options.baseUrl === 'string') {
    const baseUrl = fromRoot(folder, options.baseUrl)
    // In node_modules it names packages, and which are installed isn't the project's code
    config.baseUrl = baseUrl !== null && baseUrl.split('/').includes('node_modules') ? null : baseUrl
  }
  if (options.paths && typeof options.paths === 'object') {
    config.paths = new Set()
    for (const alias of Object.keys(options.paths)) {
      // @components/* → @components
      // @/* → @
      const prefix = alias.replace(/\/?\*$/, '')
      if (prefix) config.paths.add(prefix)
    }
  }

  // `extends` is a path or, since TypeScript 5.0, a list of them. One that names a package
  // (@tsconfig/node20) isn't followed: node_modules isn't part of a scan
  for (const parent of Array.isArray(json.extends) ? json.extends : [json.extends]) {
    if (typeof parent !== 'string' || !/^\.\.?[\\/]/.test(parent)) continue
    const path = fromRoot(folder, parent)
    // "./tsconfig.base" is tsconfig.base.json
    if (path) config.parents.push(path.endsWith('.json') ? path : `${path}.json`)
  }

  return config
}

/** What's directly under a `baseUrl` folder, as an import can name it */
async function readBaseUrl(root: string, baseUrl: string): Promise<Pick<TsconfigScope, 'baseUrlFolders' | 'baseUrlModules'>> {
  const baseUrlFolders = new Set<string>()
  const baseUrlModules = new Set<string>()

  let entries: import('node:fs').Dirent[]
  try {
    entries = await readdir(resolve(root, baseUrl), { withFileTypes: true })
  } catch {
    return { baseUrlFolders, baseUrlModules } // No such folder
  }

  for (const entry of entries) {
    // Not node_modules, which is there or not with the machine. A dot name starts no bare import
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
    // A symbolic link can be either
    if (entry.isDirectory() || entry.isSymbolicLink()) baseUrlFolders.add(entry.name)
    if (entry.isDirectory()) {
      // The folder alone is a module only through its index, or what its package.json names
      try {
        const inside = await readdir(resolve(root, baseUrl, entry.name))
        if (inside.some(name => INDEX_FILE.test(name) || name === 'package.json')) baseUrlModules.add(entry.name)
      } catch {
        // Unreadable folder
      }
    } else {
      // main.ts is 'main', and an import can spell out any file's name: 'data.json'
      baseUrlModules.add(entry.name)
      baseUrlModules.add(entry.name.replace(MODULE_EXTENSION, ''))
    }
  }

  return { baseUrlFolders, baseUrlModules }
}

/**
 * Reads the tsconfig.json and jsconfig.json files of the scanned tree: the root's, and every
 * one in `files`. Returns, for each folder that has one ('' is the root), what the files
 * below it are judged by.
 *
 * A config's `baseUrl` and `paths` are its own or, when it sets none, those of the config it
 * `extends` by a relative path: test/tsconfig.json usually extends the root's. `baseUrl` is
 * relative to the config that sets it.
 *
 * @param files every scanned path
 */
export async function readTsconfigs(root: string, files: string[]): Promise<Map<string, TsconfigScope>> {
  const read = new Map<string, Promise<ConfigFile | null>>()
  const configFile = (file: string) => {
    let config = read.get(file)
    if (!config) read.set(file, config = readConfigFile(root, file))
    return config
  }

  // A config with what it inherits. `chain` is the configs being resolved, to stop at a cycle
  const inherit = async (file: string, chain: string[]): Promise<ConfigFile | null> => {
    const own = await configFile(file)
    if (!own) return null
    let { baseUrl, paths } = own
    // In a list, a later config wins over an earlier one
    for (const parent of [...own.parents].reverse()) {
      if (chain.includes(parent)) continue
      const inherited = await inherit(parent, [...chain, file])
      baseUrl ??= inherited?.baseUrl ?? null
      paths ??= inherited?.paths ?? null
    }
    return { baseUrl, paths, parents: own.parents }
  }

  const listed = new Map<string, ReturnType<typeof readBaseUrl>>()
  const scopes = new Map<string, TsconfigScope>()
  const folders = new Set(['', ...files.filter(file => CONFIG_FILE.test(file)).map(folderOf)])

  for (const folder of folders) {
    for (const name of CONFIG_NAMES) {
      const config = await inherit(folder ? `${folder}/${name}` : name, [])
      if (!config) continue
      const { baseUrl } = config
      let under = baseUrl === null ? undefined : listed.get(baseUrl)
      if (baseUrl !== null && !under) listed.set(baseUrl, under = readBaseUrl(root, baseUrl))
      scopes.set(folder, {
        paths: config.paths ?? new Set(),
        baseUrl,
        ...(await under ?? { baseUrlFolders: new Set<string>(), baseUrlModules: new Set<string>() }),
      })
      break
    }
  }

  return scopes
}

/** The config a file falls under: the nearest tsconfig.json (or jsconfig.json) above it */
export function tsconfigOf(project: ProjectContext, relativePath: string): TsconfigScope | undefined {
  const scopes = project.tsconfigs
  if (!scopes) return undefined
  let folder = relativePath
  do {
    const slash = folder.lastIndexOf('/')
    folder = slash === -1 ? '' : folder.slice(0, slash)
    const scope = scopes.get(folder)
    if (scope) return scope
  } while (folder)
  return undefined
}

/**
 * Whether TypeScript finds an import under the config's `baseUrl` before it looks in
 * node_modules: `src/settings` with a src/ folder there, `main` with a main.ts.
 */
export function isBaseUrlImport(importPath: string, scope: TsconfigScope): boolean {
  if (scope.baseUrl === null) return false
  const slash = importPath.indexOf('/')
  // More than one segment: a path into a folder that's there. What it names inside may be
  // generated, or a file the scan doesn't read, so that isn't checked
  if (slash !== -1) return scope.baseUrlFolders.has(importPath.slice(0, slash))
  // One segment: a file, or a folder with an index. A folder without one isn't a module, and
  // TypeScript goes on to node_modules for it. 'main.js' can be main.ts, which is listed as 'main'
  return scope.baseUrlModules.has(importPath.replace(/\.(?:[cm]?js|jsx)$/, ''))
}
