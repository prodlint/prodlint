import fg from 'fast-glob'
import { readFile } from 'node:fs/promises'
import { resolve, posix } from 'node:path'
import { DEPENDENCY_TO_FRAMEWORK, RATE_LIMIT_FRAMEWORKS } from './frameworks.js'
import { getImportSources } from './ast.js'
import type { FileContext, PackageScope, ProjectContext } from '../types.js'

const DEPENDENCY_FIELDS = ['dependencies', 'devDependencies', 'peerDependencies']

/** A package.json in the scanned tree, or the scanned root when it has none */
interface Manifest {
  /** From the scanned root: '' for the root itself, 'apps/web' */
  folder: string
  /** A nested package's name, which other packages import it by */
  name: string | null
  dependencies: Set<string>
  /** The workspaces it declares, in package.json or in a pnpm-workspace.yaml next to it */
  workspaces: string[]
}

/** The `packages:` list of a pnpm-workspace.yaml */
function pnpmWorkspaces(raw: string): string[] {
  const patterns: string[] = []
  let inPackages = false
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (/^packages\s*:/.test(trimmed)) {
      inPackages = true
      continue
    }
    if (inPackages) {
      if (/^-\s+/.test(trimmed)) {
        const glob = trimmed.replace(/^-\s+/, '').replace(/^['"]|['"]$/g, '')
        if (glob) patterns.push(glob)
      } else if (trimmed && !trimmed.startsWith('#')) {
        break // new top-level key
      }
    }
  }
  return patterns
}

async function readManifest(root: string, folder: string): Promise<Manifest> {
  const manifest: Manifest = { folder, name: null, dependencies: new Set(), workspaces: [] }

  try {
    const pkg = JSON.parse(await readFile(resolve(root, folder, 'package.json'), 'utf-8'))
    // Nothing imports the root by its name
    if (folder && typeof pkg.name === 'string' && pkg.name) manifest.name = pkg.name
    for (const field of DEPENDENCY_FIELDS) {
      if (pkg[field] && typeof pkg[field] === 'object') {
        for (const dep of Object.keys(pkg[field])) manifest.dependencies.add(dep)
      }
    }
    // npm and yarn: "workspaces", as a list or as { packages }
    const workspaces = Array.isArray(pkg.workspaces) ? pkg.workspaces : pkg.workspaces?.packages
    if (Array.isArray(workspaces)) manifest.workspaces.push(...workspaces)
  } catch {
    // No package.json, or invalid JSON
  }

  try {
    manifest.workspaces.push(...pnpmWorkspaces(await readFile(resolve(root, folder, 'pnpm-workspace.yaml'), 'utf-8')))
  } catch {
    // No pnpm-workspace.yaml
  }

  manifest.workspaces = manifest.workspaces.filter(pattern => typeof pattern === 'string' && pattern !== '')
  return manifest
}

/** `apps/web/package.json` → `apps/web`, and the root's is '' */
function folderOf(file: string): string {
  const folder = posix.dirname(posix.normalize(file))
  return folder === '.' ? '' : folder
}

/** The folders of the packages a manifest's workspaces name */
async function memberFolders(root: string, manifest: Manifest): Promise<string[]> {
  try {
    const files = await fg(manifest.workspaces.map(pattern => `${pattern}/package.json`), {
      cwd: resolve(root, manifest.folder),
      absolute: false,
      ignore: ['**/node_modules/**'],
    })
    return files.map(file => folderOf(posix.join(manifest.folder, file)))
  } catch {
    return [] // Glob failed
  }
}

/** The scoped packages a file imports or re-exports, by name: `@acme/db/client` is `@acme/db` */
function scopedImports(file: FileContext): string[] {
  if (!file.ast) return []
  const sources: string[] = []
  try {
    for (const node of file.ast.program.body) {
      if (
        (node.type === 'ImportDeclaration' || node.type === 'ExportNamedDeclaration' || node.type === 'ExportAllDeclaration') &&
        node.source
      ) {
        sources.push(node.source.value)
      }
    }
    // require('x') and import('x') can be anywhere in the file
    if (/\b(?:require|import)\s*\(/.test(file.content)) {
      for (const { source } of getImportSources(file.ast)) sources.push(source)
    }
  } catch {
    // AST walk failed
  }
  return sources
    .filter(source => source.startsWith('@'))
    .map(source => source.split('/').slice(0, 2).join('/'))
}

/** The nearest of `folders` above a path. With none, the root: '' */
function nearest(folders: Map<string, unknown>, path: string): string {
  let folder = path
  do {
    const slash = folder.lastIndexOf('/')
    folder = slash === -1 ? '' : folder.slice(0, slash)
  } while (folder && !folders.has(folder))
  return folder
}

/**
 * Reads every package.json in the scanned tree. Returns what all of them declare together,
 * and for each package's folder ('' is the root) the frameworks its own files are judged by.
 *
 * A file belongs to the nearest package.json above it, and is judged by the frameworks of:
 * - that package, and the packages above it up to the scanned root. Node resolves an import
 *   through every folder above a file, so a package.json added to a folder takes nothing away
 * - its workspace, when a package.json or pnpm-workspace.yaml in the tree declares it one: a
 *   workspace root and its members share what each of them declares, as they always did
 * - the scanned packages any of those depend on by name, and the ones those depend on: an
 *   app that queries through its `db` package uses that package's ORM. The dependency is in
 *   its package.json, or its files import the package by a scoped name (`@acme/db`). Such a
 *   package brings what it declares, not what's above it: a name can be a fixture's too
 *
 * So a package that nothing above it declares or depends on, like an example app or a test
 * fixture, changes nothing outside its own folder.
 *
 * @param files the scanned files, for what they import
 */
export async function readPackages(root: string, files: FileContext[] = []): Promise<{
  declaredDependencies: Set<string>
  frameworks: Map<string, Set<string>>
}> {
  const manifests = new Map<string, Manifest>()
  /** Workspace root → its members */
  const members = new Map<string, string[]>()

  let found: string[] = []
  try {
    found = await fg(['**/package.json', '**/pnpm-workspace.yaml'], {
      cwd: root,
      absolute: false,
      ignore: ['**/node_modules/**'],
    })
  } catch {
    // Glob failed
  }

  // The root counts with no package.json too: what's outside every nested package is its
  // own. And a workspace can name a package the glob doesn't reach, in a dot folder
  const queue = ['', ...found.map(folderOf)]
  for (const folder of queue) {
    if (manifests.has(folder)) continue
    const manifest = await readManifest(root, folder)
    manifests.set(folder, manifest)
    if (manifest.workspaces.length > 0) {
      const folders = await memberFolders(root, manifest)
      members.set(folder, folders)
      queue.push(...folders)
    }
  }

  // A workspace root and its members are judged as one: union-find over their folders
  const joined = new Map<string, string>()
  const groupOf = (folder: string): string => {
    let top = folder
    while (joined.has(top)) top = joined.get(top)!
    if (top !== folder) joined.set(folder, top)
    return top
  }
  for (const [workspace, folders] of members) {
    for (const folder of folders) {
      const [a, b] = [groupOf(workspace), groupOf(folder)]
      if (a !== b) joined.set(b, a)
    }
  }

  const declaredDependencies = new Set<string>()
  const byName = new Map<string, string[]>()
  for (const { folder, name, dependencies } of manifests.values()) {
    for (const dep of dependencies) declaredDependencies.add(dep)
    if (name) {
      declaredDependencies.add(name)
      byName.set(name, [...(byName.get(name) ?? []), folder])
    }
  }

  // Per group: the frameworks its packages declare, the groups above its packages, and the
  // groups its packages depend on
  const declares = new Map<string, Set<string>>()
  const above = new Map<string, Set<string>>()
  const uses = new Map<string, Set<string>>()
  for (const { folder, name, dependencies } of manifests.values()) {
    const group = groupOf(folder)
    if (!declares.has(group)) {
      declares.set(group, new Set())
      above.set(group, new Set())
      uses.set(group, new Set())
    }
    // Its name counts like a dependency, as it did when workspaces were first merged
    for (const dep of name ? [...dependencies, name] : dependencies) {
      const framework = DEPENDENCY_TO_FRAMEWORK[dep]
      if (framework) declares.get(group)!.add(framework)
    }
    for (const dep of dependencies) {
      for (const other of byName.get(dep) ?? []) uses.get(group)!.add(groupOf(other))
    }
    if (folder) above.get(group)!.add(groupOf(nearest(manifests, folder)))
  }
  // A hoisted workspace lets a package import another with nothing in its package.json, and
  // a scan that starts below the workspace's root can't see they're one. So an import counts
  // as a dependency, by a scoped name only: `app`, `server` and `utils` are also what folders
  // and path aliases are called
  if ([...byName.keys()].some(name => name.startsWith('@'))) {
    for (const file of files) {
      const group = groupOf(nearest(manifests, file.relativePath))
      for (const name of scopedImports(file)) {
        for (const other of byName.get(name) ?? []) uses.get(group)!.add(groupOf(other))
      }
    }
  }

  const scopes = new Map<string, Set<string>>()
  for (const group of declares.keys()) {
    // A Set's loop reaches what's added to it on the way: first everything above the group,
    // then what any of those depends on, and what that depends on
    const reached = new Set([group])
    for (const current of reached) for (const next of above.get(current)!) reached.add(next)
    for (const current of reached) for (const next of uses.get(current)!) reached.add(next)

    const frameworks = new Set<string>()
    for (const current of reached) for (const framework of declares.get(current)!) frameworks.add(framework)
    scopes.set(group, frameworks)
  }

  const frameworks = new Map<string, Set<string>>()
  for (const folder of manifests.keys()) frameworks.set(folder, scopes.get(groupOf(folder))!)
  return { declaredDependencies, frameworks }
}

/** A rate-limiting package among the frameworks */
export function hasRateLimitPackage(frameworks: Set<string>): boolean {
  return [...frameworks].some(framework => RATE_LIMIT_FRAMEWORKS.has(framework))
}

/**
 * What a file's package is judged by: the nearest package.json above the file. A context
 * with no package map, which is how a test builds one, gives the project's own.
 */
export function packageOf(project: ProjectContext, relativePath: string): PackageScope {
  const scopes = project.packageScopes
  const scope = scopes?.get(nearest(scopes, relativePath))
  return scope ?? { frameworks: project.detectedFrameworks, hasRateLimiting: project.hasRateLimiting }
}
