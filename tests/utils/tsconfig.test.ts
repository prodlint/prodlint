import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { parseJsonc, readTsconfigs, tsconfigOf, isBaseUrlImport } from '../../src/utils/tsconfig.js'
import { buildProjectContext } from '../../src/utils/file-walker.js'
import { makeProject } from '../helpers.js'
import type { TsconfigScope } from '../../src/types.js'

describe('parseJsonc', () => {
  it('reads plain JSON', () => {
    expect(parseJsonc('{ "a": [1, 2], "b": { "c": null } }')).toEqual({ a: [1, 2], b: { c: null } })
  })

  it('skips line comments', () => {
    expect(parseJsonc('{\n  // the target\n  "target": "es2022" // inline\n}')).toEqual({ target: 'es2022' })
  })

  it('ends a line comment at any line ending', () => {
    expect(parseJsonc('{\r\n  // one\r\n  "a": 1\r\n}')).toEqual({ a: 1 })
    expect(parseJsonc('{\r  // one\r  "a": 1\r}')).toEqual({ a: 1 })
  })

  it('skips block comments, on one line or several', () => {
    expect(parseJsonc('{\n  /* Base Options: */\n  "strict": true, /* all\n of them */ "jsx": "preserve"\n}'))
      .toEqual({ strict: true, jsx: 'preserve' })
  })

  it('allows a trailing comma in an object and in a list', () => {
    expect(parseJsonc('{ "include": ["src", "tests",], "compilerOptions": { "strict": true, }, }'))
      .toEqual({ include: ['src', 'tests'], compilerOptions: { strict: true } })
  })

  it('allows a trailing comma with a comment between it and the closing brace', () => {
    expect(parseJsonc('{\n  "a": 1, // one\n  /* done */\n}')).toEqual({ a: 1 })
  })

  it('keeps // inside a string: a URL starts no comment', () => {
    expect(parseJsonc('{ "$schema": "https://json.schemastore.org/tsconfig", "extends": "./base.json" }'))
      .toEqual({ $schema: 'https://json.schemastore.org/tsconfig', extends: './base.json' })
  })

  it('keeps /* and a comma inside a string', () => {
    expect(parseJsonc('{ "include": ["src/**/*", "a,]"], "note": "x /* y */ z" }'))
      .toEqual({ include: ['src/**/*', 'a,]'], note: 'x /* y */ z' })
  })

  it('reads an escaped quote as part of its string', () => {
    expect(parseJsonc('{ "a": "say \\"// hi\\"", "b": "back\\\\" /* c */ }')).toEqual({ a: 'say "// hi"', b: 'back\\' })
  })

  it('skips a byte order mark', () => {
    expect(parseJsonc('\uFEFF{ "a": 1 }')).toEqual({ a: 1 })
  })

  it('reads what `tsc --init` writes', () => {
    const text = [
      '{',
      '  "compilerOptions": {',
      '    /* Visit https://aka.ms/tsconfig to read more about this file */',
      '',
      '    /* Language and Environment */',
      '    "target": "es2016",                                  /* Set the JavaScript language version for emitted JavaScript. */',
      '    // "lib": [],                                        /* Specify a set of bundled library declaration files. */',
      '    "baseUrl": "./",                                     /* Specify the base directory to resolve non-relative module names. */',
      '    // "paths": {},                                      /* Specify a set of entries that re-map imports. */',
      '    "skipLibCheck": true                                 /* Skip type checking all .d.ts files. */',
      '  }',
      '}',
    ].join('\r\n')
    expect(parseJsonc(text)).toEqual({ compilerOptions: { target: 'es2016', baseUrl: './', skipLibCheck: true } })
  })

  it('still rejects what is not JSON', () => {
    expect(() => parseJsonc('{ "a": 1,, "b": 2 }')).toThrow()
    expect(() => parseJsonc('{ "a": [1,,] }')).toThrow()
    expect(() => parseJsonc('{ a: 1 }')).toThrow()
    expect(() => parseJsonc('{ "a": 1 "b": 2 }')).toThrow()
    expect(() => parseJsonc('')).toThrow()
  })

  it('reads to the end of an unclosed comment or string without hanging', () => {
    expect(parseJsonc('{ "a": 1 } /* never closed')).toEqual({ a: 1 })
    expect(() => parseJsonc('{ "a": "never closed')).toThrow()
    expect(() => parseJsonc('{ "a": "ends on a backslash\\')).toThrow()
    expect(() => parseJsonc('/*'.repeat(50_000))).toThrow()
  })
})

describe('readTsconfigs', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'prodlint-tsconfig-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  /** Writes the files and returns their paths, as the scanner's walk would list them */
  function write(files: Record<string, string | object>): string[] {
    for (const [path, content] of Object.entries(files)) {
      const full = join(dir, path)
      mkdirSync(dirname(full), { recursive: true })
      writeFileSync(full, typeof content === 'string' ? content : JSON.stringify(content, null, 2))
    }
    return Object.keys(files)
  }

  it('reads the root tsconfig.json: its baseUrl, and what is under it', async () => {
    const files = write({
      'tsconfig.json': { compilerOptions: { baseUrl: '.' } },
      'main.ts': '',
      'src/settings.ts': '',
    })

    const scope = (await readTsconfigs(dir, files)).get('')

    expect(scope?.baseUrl).toBe('')
    expect([...scope!.baseUrlFolders]).toEqual(['src'])
    expect(scope!.baseUrlModules.has('main')).toBe(true)
    expect(scope!.baseUrlModules.has('main.ts')).toBe(true)
    // src/ has no index: `import … from 'src'` isn't a module
    expect(scope!.baseUrlModules.has('src')).toBe(false)
  })

  it('reads the root tsconfig.json even when the file list has none', async () => {
    write({ 'tsconfig.json': { compilerOptions: { baseUrl: 'src', paths: { '@lib/*': ['lib/*'] } } }, 'src/app/x.ts': '' })

    const scope = (await readTsconfigs(dir, [])).get('')

    expect(scope?.baseUrl).toBe('src')
    expect([...scope!.baseUrlFolders]).toEqual(['app'])
    expect([...scope!.paths]).toEqual(['@lib'])
  })

  it('returns nothing for a project with no config', async () => {
    const files = write({ 'index.ts': '' })
    expect((await readTsconfigs(dir, files)).size).toBe(0)
  })

  it.each([
    ['.', ''],
    ['./', ''],
    ['./src', 'src'],
    ['src/', 'src'],
    ['.\\src', 'src'],
  ])('reads baseUrl %j as the folder %j', async (baseUrl, folder) => {
    const files = write({ 'tsconfig.json': { compilerOptions: { baseUrl } }, 'src/a.ts': '' })
    expect((await readTsconfigs(dir, files)).get('')?.baseUrl).toBe(folder)
  })

  // ${configDir} is the folder of whichever config is being read, not of the one that says it
  it.each(['..', '../shared', '../', '/abs/olute', 'C:\\abs\\olute', '${configDir}/src', '${configDir}'])(
    'leaves out a baseUrl outside the scanned folder, or with a template: %j',
    async baseUrl => {
      const files = write({ 'tsconfig.json': { compilerOptions: { baseUrl } }, 'src/a.ts': '' })
      const scope = (await readTsconfigs(dir, files)).get('')
      expect(scope?.baseUrl).toBeNull()
      expect(scope!.baseUrlFolders.size).toBe(0)
    },
  )

  it.each(['node_modules', './node_modules/', 'packages/app/node_modules/@types'])(
    'leaves out a baseUrl in node_modules, where the names are packages: %j',
    async baseUrl => {
      const files = write({ 'tsconfig.json': { compilerOptions: { baseUrl } } })
      write({ 'node_modules/left-pad/index.js': '', 'packages/app/node_modules/@types/node/index.d.ts': '' })
      const scope = (await readTsconfigs(dir, files)).get('')
      expect(scope?.baseUrl).toBeNull()
      expect(scope!.baseUrlFolders.size).toBe(0)
    },
  )

  it('reads a config with block comments, trailing commas and a URL', async () => {
    const files = write({
      'tsconfig.json': [
        '{',
        '  "$schema": "https://json.schemastore.org/tsconfig",',
        '  "compilerOptions": {',
        '    /* Path Aliases */',
        '    "baseUrl": ".", // the project',
        '    "paths": { "~app/*": ["./src/*"], },',
        '  },',
        '}',
      ].join('\n'),
      'src/a.ts': '',
    })

    const scope = (await readTsconfigs(dir, files)).get('')

    expect(scope?.baseUrl).toBe('')
    expect([...scope!.paths]).toEqual(['~app'])
  })

  it('gives a config that is not JSON at all an empty scope', async () => {
    const files = write({ 'tsconfig.json': '{ compilerOptions: nope', 'src/a.ts': '' })
    expect((await readTsconfigs(dir, files)).get('')).toEqual({ paths: new Set(), baseUrl: null, baseUrlFolders: new Set(), baseUrlModules: new Set() })
  })

  it.each([
    '[]',
    '"text"',
    'null',
    '{ "compilerOptions": 3 }',
    '{ "compilerOptions": null }',
    '{ "compilerOptions": { "baseUrl": 3, "paths": "nope" }, "extends": 3 }',
    '{ "extends": [["./tsconfig.base.json"]] }',
    '{ "extends": { "0": "./tsconfig.base.json" } }',
  ])('reads nothing from a config of the wrong shape: %s', async text => {
    const files = write({ 'tsconfig.json': text, 'tsconfig.base.json': { compilerOptions: { baseUrl: '.', paths: { '@base/*': ['*'] } } } })
    const scope = (await readTsconfigs(dir, files)).get('')
    expect(scope?.baseUrl).toBeNull()
    expect(scope!.paths.size).toBe(0)
  })

  it('skips a config over the size the scanner reads', async () => {
    const files = write({ 'tsconfig.json': `{ "compilerOptions": { "baseUrl": "." } }${' '.repeat(1024 * 1024)}` })
    expect((await readTsconfigs(dir, files)).size).toBe(0)
  })

  it('reads the prefixes of paths', async () => {
    const files = write({
      'tsconfig.json': { compilerOptions: { paths: { '@components/*': ['src/components/*'], '@/*': ['src/*'], 'cache-decorator': ['lib/cache'], '*': ['types/*'] } } },
    })
    const scope = (await readTsconfigs(dir, files)).get('')
    expect([...scope!.paths]).toEqual(['@components', '@', 'cache-decorator'])
    expect(scope!.baseUrl).toBeNull()
  })

  it('reads a nested config for its own folder, with baseUrl relative to it', async () => {
    const files = write({
      'tsconfig.json': { compilerOptions: {} },
      'apps/web/tsconfig.json': { compilerOptions: { baseUrl: '.', paths: { '@ui/*': ['components/ui/*'] } } },
      'apps/web/components/button.tsx': '',
      'apps/api/tsconfig.json': { compilerOptions: { baseUrl: './src' } },
      'apps/api/src/users/users.service.ts': '',
    })

    const scopes = await readTsconfigs(dir, files)

    expect([...scopes.keys()].sort()).toEqual(['', 'apps/api', 'apps/web'])
    expect(scopes.get('')?.baseUrl).toBeNull()
    expect(scopes.get('apps/web')?.baseUrl).toBe('apps/web')
    expect([...scopes.get('apps/web')!.baseUrlFolders]).toEqual(['components'])
    expect([...scopes.get('apps/web')!.paths]).toEqual(['@ui'])
    expect(scopes.get('apps/api')?.baseUrl).toBe('apps/api/src')
    expect([...scopes.get('apps/api')!.baseUrlFolders]).toEqual(['users'])
  })

  it('reads a nested baseUrl that climbs to a folder inside the root', async () => {
    const files = write({ 'packages/app/tsconfig.json': { compilerOptions: { baseUrl: '../..' } }, 'packages/app/a.ts': '', 'shared/b.ts': '' })
    const scope = (await readTsconfigs(dir, files)).get('packages/app')
    expect(scope?.baseUrl).toBe('')
    expect([...scope!.baseUrlFolders].sort()).toEqual(['packages', 'shared'])
  })

  it('only reads nested configs the scan lists', async () => {
    // Ignored by the scan: build/ always is, and lib/tsconfig.json could be by --ignore
    write({ 'build/tsconfig.json': { compilerOptions: { baseUrl: '.' } }, 'lib/tsconfig.json': { compilerOptions: { baseUrl: '.' } } })
    const files = write({
      'src/tsconfig.json': { compilerOptions: { baseUrl: '.' } },
      'src/tsconfig.app.json': { compilerOptions: { baseUrl: '..' } },
      'lib/tsconfig.build.json': { compilerOptions: { baseUrl: '.' } },
      'lib/mytsconfig.json': { compilerOptions: { baseUrl: '.' } },
    })
    expect([...(await readTsconfigs(dir, files)).keys()]).toEqual(['src'])
  })

  it('reads a jsconfig.json where there is no tsconfig.json', async () => {
    const files = write({ 'jsconfig.json': { compilerOptions: { baseUrl: 'src' } }, 'src/lib/a.js': '' })
    const scope = (await readTsconfigs(dir, files)).get('')
    expect(scope?.baseUrl).toBe('src')
    expect([...scope!.baseUrlFolders]).toEqual(['lib'])
  })

  it('prefers the tsconfig.json of a folder that has both', async () => {
    const files = write({
      'tsconfig.json': { compilerOptions: { paths: { '@ts/*': ['src/*'] } } },
      'jsconfig.json': { compilerOptions: { baseUrl: 'src', paths: { '@js/*': ['src/*'] } } },
    })
    const scope = (await readTsconfigs(dir, files)).get('')
    expect([...scope!.paths]).toEqual(['@ts'])
    expect(scope!.baseUrl).toBeNull()
  })

  describe('what is under baseUrl', () => {
    it('lists folders, and as modules only those with an index or a package.json', async () => {
      const files = write({
        'tsconfig.json': { compilerOptions: { baseUrl: 'src' } },
        'src/hooks/index.ts': '',
        'src/views/index.tsx': '',
        'src/legacy/index.js': '',
        'src/types/index.d.ts': '',
        'src/esm/index.mjs': '',
        'src/vendored/package.json': '{}',
        'src/config/default.json': '{}',
        'src/indexes/indexes.ts': '',
        'src/styles/main.css': '',
      })

      const scope = (await readTsconfigs(dir, files)).get('')!

      expect([...scope.baseUrlFolders].sort()).toEqual(['config', 'esm', 'hooks', 'indexes', 'legacy', 'styles', 'types', 'vendored', 'views'])
      expect([...scope.baseUrlModules].sort()).toEqual(['esm', 'hooks', 'legacy', 'types', 'vendored', 'views'])
    })

    it('lists files by their name and by what an import calls them', async () => {
      const files = write({
        'tsconfig.json': { compilerOptions: { baseUrl: 'src' } },
        'src/main.ts': '',
        'src/App.tsx': '',
        'src/direction.util.ts': '',
        'src/globals.d.ts': '',
        'src/worker.mjs': '',
        'src/legacy.cjs': '',
        'src/data.json': '{}',
        'src/index.css': '',
        'src/Logo.vue': '',
      })

      const scope = (await readTsconfigs(dir, files)).get('')!

      expect(scope.baseUrlFolders.size).toBe(0)
      expect([...scope.baseUrlModules].sort()).toEqual([
        'App', 'App.tsx', 'Logo.vue', 'data.json', 'direction.util', 'direction.util.ts', 'globals', 'globals.d.ts',
        'index.css', 'legacy', 'legacy.cjs', 'main', 'main.ts', 'worker', 'worker.mjs',
      ])
    })

    it('sees folders the scan does not walk: only stylesheets, only declarations', async () => {
      const files = write({ 'tsconfig.json': { compilerOptions: { baseUrl: '.' } }, 'pages/_app.tsx': '' })
      write({ 'styles/globals.css': '', 'types/api.d.ts': '', 'dist/index.js': '' })

      const scope = (await readTsconfigs(dir, files)).get('')!

      expect([...scope.baseUrlFolders].sort()).toEqual(['dist', 'pages', 'styles', 'types'])
      expect([...scope.baseUrlModules].sort()).toEqual(['dist', 'tsconfig.json'])
    })

    it('leaves out node_modules and dot names: installed packages are not the project, and no bare import starts with a dot', async () => {
      const files = write({ 'tsconfig.json': { compilerOptions: { baseUrl: '.' } }, 'src/a.ts': '' })
      write({ 'node_modules/left-pad/index.js': '', '.cache/index.js': '', '.eslintrc.js': '' })

      const scope = (await readTsconfigs(dir, files)).get('')!

      expect([...scope.baseUrlFolders]).toEqual(['src'])
      expect([...scope.baseUrlModules]).toEqual(['tsconfig.json'])
    })

    it('counts a symbolic link as a folder', async () => {
      const files = write({ 'tsconfig.json': { compilerOptions: { baseUrl: 'src' } }, 'src/renderer/pages/Home.tsx': '' })
      // 'junction' matters on Windows only, where a plain folder link needs a privilege
      symlinkSync(join(dir, 'src/renderer/pages'), join(dir, 'src/pages'), 'junction')

      const scope = (await readTsconfigs(dir, files)).get('')!

      expect([...scope.baseUrlFolders].sort()).toEqual(['pages', 'renderer'])
    })

    it('lists nothing when the folder does not exist', async () => {
      const files = write({ 'tsconfig.json': { compilerOptions: { baseUrl: 'app' } } })
      const scope = (await readTsconfigs(dir, files)).get('')!
      expect(scope.baseUrl).toBe('app')
      expect(scope.baseUrlFolders.size + scope.baseUrlModules.size).toBe(0)
    })
  })

  describe('extends', () => {
    it('inherits baseUrl and paths, with baseUrl relative to the config that sets it', async () => {
      const files = write({
        'tsconfig.json': { compilerOptions: { baseUrl: '.', paths: { '@app/*': ['src/*'] } } },
        'src/a.ts': '',
        'test/tsconfig.json': { extends: '../tsconfig.json', compilerOptions: { types: ['jest'] } },
        'test/a.spec.ts': '',
      })

      const scope = (await readTsconfigs(dir, files)).get('test')!

      expect(scope.baseUrl).toBe('')
      expect([...scope.baseUrlFolders].sort()).toEqual(['src', 'test'])
      expect([...scope.paths]).toEqual(['@app'])
    })

    it('keeps what the config sets itself', async () => {
      const files = write({
        'tsconfig.base.json': { compilerOptions: { baseUrl: '.', paths: { '@base/*': ['libs/*'] } } },
        'apps/web/tsconfig.json': { extends: '../../tsconfig.base.json', compilerOptions: { baseUrl: 'src', paths: { '@web/*': ['*'] } } },
        'apps/web/src/a.ts': '',
      })

      const scope = (await readTsconfigs(dir, files)).get('apps/web')!

      expect(scope.baseUrl).toBe('apps/web/src')
      expect([...scope.paths]).toEqual(['@web'])
    })

    it('inherits one and keeps the other', async () => {
      const files = write({
        'tsconfig.base.json': { compilerOptions: { baseUrl: '.', paths: { '@base/*': ['libs/*'] } } },
        'libs/x.ts': '',
        'apps/web/tsconfig.json': { extends: '../../tsconfig.base.json', compilerOptions: { paths: {} } },
        'apps/api/tsconfig.json': { extends: '../../tsconfig.base.json', compilerOptions: { baseUrl: '.' } },
      })

      const scopes = await readTsconfigs(dir, files)

      // An empty paths replaces the inherited ones, as in TypeScript
      expect(scopes.get('apps/web')!.paths.size).toBe(0)
      expect(scopes.get('apps/web')!.baseUrl).toBe('')
      expect([...scopes.get('apps/api')!.paths]).toEqual(['@base'])
      expect(scopes.get('apps/api')!.baseUrl).toBe('apps/api')
      // tsconfig.base.json isn't a config of its own folder
      expect(scopes.has('')).toBe(false)
    })

    it('follows a chain, and a name without .json', async () => {
      const files = write({
        'config/tsconfig.root.json': { compilerOptions: { baseUrl: '..' } },
        'config/tsconfig.shared.json': { extends: './tsconfig.root', compilerOptions: { paths: { '@shared/*': ['shared/*'] } } },
        'tsconfig.json': { extends: './config/tsconfig.shared' },
        'shared/a.ts': '',
      })

      const scope = (await readTsconfigs(dir, files)).get('')!

      expect(scope.baseUrl).toBe('')
      expect([...scope.paths]).toEqual(['@shared'])
    })

    it('reads a list of configs, the later one winning', async () => {
      const files = write({
        'one.json': { compilerOptions: { baseUrl: 'one', paths: { '@one/*': ['*'] } } },
        'two.json': { compilerOptions: { baseUrl: 'two' } },
        'tsconfig.json': { extends: ['./one.json', './two.json'] },
      })

      const scope = (await readTsconfigs(dir, files)).get('')!

      expect(scope.baseUrl).toBe('two')
      expect([...scope.paths]).toEqual(['@one'])
    })

    it('stops at a config that extends itself, and at a cycle', async () => {
      const files = write({
        'tsconfig.json': { extends: './tsconfig.json', compilerOptions: { baseUrl: 'src' } },
        'a/tsconfig.json': { extends: '../b/tsconfig.json' },
        'b/tsconfig.json': { extends: '../a/tsconfig.json', compilerOptions: { paths: { '@b/*': ['*'] } } },
      })

      const scopes = await readTsconfigs(dir, files)

      expect(scopes.get('')!.baseUrl).toBe('src')
      expect([...scopes.get('a')!.paths]).toEqual(['@b'])
      expect([...scopes.get('b')!.paths]).toEqual(['@b'])
    })

    it('does not follow a package or a missing file', async () => {
      write({ 'node_modules/@tsconfig/node20/tsconfig.json': { compilerOptions: { baseUrl: '.' } } })
      const files = write({
        'tsconfig.json': { extends: '@tsconfig/node20/tsconfig.json' },
        'a/tsconfig.json': { extends: './.svelte-kit/tsconfig.json' },
        // No ./ in front: TypeScript looks for a package of that name
        'b/tsconfig.json': { extends: 'tsconfig.base.json' },
        'b/tsconfig.base.json': { compilerOptions: { baseUrl: '.', paths: { '@b/*': ['*'] } } },
        'tsconfig.base.json': { compilerOptions: { baseUrl: '.', paths: { '@root/*': ['*'] } } },
      })

      const scopes = await readTsconfigs(dir, files)

      for (const folder of ['', 'a', 'b']) {
        expect(scopes.get(folder)).toEqual({ paths: new Set(), baseUrl: null, baseUrlFolders: new Set(), baseUrlModules: new Set() })
      }
    })

    it('does not follow a path out of the scanned folder', async () => {
      // The scan starts at project/, and the config it extends is beside it
      write({ 'tsconfig.base.json': { compilerOptions: { baseUrl: '.', paths: { '@above/*': ['*'] } } } })
      write({ 'project/tsconfig.json': { extends: '../tsconfig.base.json' }, 'project/src/a.ts': '' })

      const scope = (await readTsconfigs(join(dir, 'project'), ['tsconfig.json', 'src/a.ts'])).get('')

      expect(scope).toEqual({ paths: new Set(), baseUrl: null, baseUrlFolders: new Set(), baseUrlModules: new Set() })
    })
  })
})

describe('buildProjectContext — tsconfig', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'prodlint-tsconfig-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it("keeps the root config's paths as tsconfigPaths, whatever the config's comments", async () => {
    writeFileSync(join(dir, 'tsconfig.json'), '{\n  /* aliases */\n  "compilerOptions": { "paths": { "@components/*": ["src/components/*"], }, },\n}\n')
    mkdirSync(join(dir, 'apps/web'), { recursive: true })
    writeFileSync(join(dir, 'apps/web/tsconfig.json'), JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@web/*': ['*'] } } }))

    const project = await buildProjectContext(dir, ['tsconfig.json', 'apps/web/tsconfig.json'])

    expect([...project.tsconfigPaths]).toEqual(['@components'])
    expect([...project.tsconfigs!.keys()]).toEqual(['', 'apps/web'])
    expect(tsconfigOf(project, 'apps/web/page.tsx')?.baseUrl).toBe('apps/web')
    expect(tsconfigOf(project, 'lib/x.ts')?.baseUrl).toBeNull()
  })

  it('has no tsconfigPaths and no configs in a project without a tsconfig', async () => {
    writeFileSync(join(dir, 'package.json'), '{}')

    const project = await buildProjectContext(dir, ['package.json'])

    expect(project.tsconfigPaths.size).toBe(0)
    expect(project.tsconfigs!.size).toBe(0)
    expect(tsconfigOf(project, 'src/index.ts')).toBeUndefined()
  })
})

describe('tsconfigOf', () => {
  const scope = (baseUrl: string): TsconfigScope => ({ paths: new Set(), baseUrl, baseUrlFolders: new Set(), baseUrlModules: new Set() })

  it('finds the nearest config above a file', () => {
    const project = makeProject({ tsconfigs: new Map([['', scope('')], ['apps/web', scope('apps/web')], ['apps/web/e2e', scope('apps/web/e2e')]]) })

    expect(tsconfigOf(project, 'index.ts')?.baseUrl).toBe('')
    expect(tsconfigOf(project, 'apps/api/main.ts')?.baseUrl).toBe('')
    expect(tsconfigOf(project, 'apps/web/app/page.tsx')?.baseUrl).toBe('apps/web')
    expect(tsconfigOf(project, 'apps/web/e2e/login.spec.ts')?.baseUrl).toBe('apps/web/e2e')
    // A folder whose name starts like another's isn't under it
    expect(tsconfigOf(project, 'apps/web-admin/page.tsx')?.baseUrl).toBe('')
  })

  it('finds none where no config is above the file', () => {
    const project = makeProject({ tsconfigs: new Map([['apps/web', scope('apps/web')]]) })

    expect(tsconfigOf(project, 'apps/web/page.tsx')?.baseUrl).toBe('apps/web')
    expect(tsconfigOf(project, 'apps/api/main.ts')).toBeUndefined()
    expect(tsconfigOf(project, 'index.ts')).toBeUndefined()
  })

  it('finds none in a project context without configs', () => {
    expect(tsconfigOf(makeProject(), 'src/index.ts')).toBeUndefined()
    expect(tsconfigOf(makeProject({ tsconfigs: new Map() }), 'src/index.ts')).toBeUndefined()
  })
})

describe('isBaseUrlImport', () => {
  const scope: TsconfigScope = {
    paths: new Set(),
    baseUrl: '',
    baseUrlFolders: new Set(['src', 'config', '@core']),
    baseUrlModules: new Set(['main', 'main.ts', 'data.json', 'hooks']),
  }

  it('takes a path into a folder under baseUrl', () => {
    expect(isBaseUrlImport('src/settings', scope)).toBe(true)
    expect(isBaseUrlImport('src/generated/graphql.js', scope)).toBe(true)
    expect(isBaseUrlImport('@core/services/auth', scope)).toBe(true)
    expect(isBaseUrlImport('config/default.json', scope)).toBe(true)
  })

  it('takes one segment that names a file or a folder with an index', () => {
    expect(isBaseUrlImport('main', scope)).toBe(true)
    expect(isBaseUrlImport('main.ts', scope)).toBe(true)
    expect(isBaseUrlImport('data.json', scope)).toBe(true)
    expect(isBaseUrlImport('hooks', scope)).toBe(true)
  })

  it("takes the JavaScript name of a TypeScript file: 'main.js' for main.ts", () => {
    expect(isBaseUrlImport('main.js', scope)).toBe(true)
    expect(isBaseUrlImport('main.mjs', scope)).toBe(true)
    expect(isBaseUrlImport('main.jsx', scope)).toBe(true)
  })

  it('leaves a folder without an index to node_modules', () => {
    expect(isBaseUrlImport('config', scope)).toBe(false)
    expect(isBaseUrlImport('src', scope)).toBe(false)
  })

  it('leaves what is not under baseUrl', () => {
    expect(isBaseUrlImport('lodahs', scope)).toBe(false)
    expect(isBaseUrlImport('lodash/fp', scope)).toBe(false)
    expect(isBaseUrlImport('@scope/pkg', scope)).toBe(false)
    expect(isBaseUrlImport('data', scope)).toBe(false)
    // A file has nothing inside it, and a module isn't a folder
    expect(isBaseUrlImport('main/inner', scope)).toBe(false)
    expect(isBaseUrlImport('hooks/useThing', scope)).toBe(false)
  })

  it('takes nothing without a baseUrl', () => {
    expect(isBaseUrlImport('src/settings', { ...scope, baseUrl: null })).toBe(false)
    expect(isBaseUrlImport('main', { ...scope, baseUrl: null })).toBe(false)
  })
})
