import { describe, it, expect } from 'vitest'
import { hallucinatedImportsRule } from '../../src/rules/hallucinated-imports.js'
import { makeFile, makeProject, scanFiles } from '../helpers.js'

describe('hallucinated-imports rule', () => {
  it('flags import of undeclared package', () => {
    const file = makeFile(`import { foo } from 'some-unknown-pkg'`)
    const project = makeProject({ packageJson: {} })
    const findings = hallucinatedImportsRule.check(file, project)
    expect(findings).toHaveLength(1)
    expect(findings[0].message).toContain('some-unknown-pkg')
  })

  it('allows declared dependency', () => {
    const file = makeFile(`import fg from 'fast-glob'`)
    const project = makeProject({
      packageJson: {},
      declaredDependencies: new Set(['fast-glob']),
    })
    const findings = hallucinatedImportsRule.check(file, project)
    expect(findings).toHaveLength(0)
  })

  it('allows Node builtins', () => {
    const file = makeFile(`import { readFileSync } from 'fs'`)
    const project = makeProject({ packageJson: {} })
    const findings = hallucinatedImportsRule.check(file, project)
    expect(findings).toHaveLength(0)
  })

  it('allows node: prefixed builtins', () => {
    const file = makeFile(`import { resolve } from 'node:path'`)
    const project = makeProject({ packageJson: {} })
    const findings = hallucinatedImportsRule.check(file, project)
    expect(findings).toHaveLength(0)
  })

  it('allows implicit packages (react, next)', () => {
    const file = makeFile(`import React from 'react'\nimport Link from 'next/link'`)
    const project = makeProject({ packageJson: {} })
    const findings = hallucinatedImportsRule.check(file, project)
    expect(findings).toHaveLength(0)
  })

  it('allows @/ path alias', () => {
    const file = makeFile(`import { cn } from '@/lib/utils'`)
    const project = makeProject({ packageJson: {} })
    const findings = hallucinatedImportsRule.check(file, project)
    expect(findings).toHaveLength(0)
  })

  it('allows ~/ path alias', () => {
    const file = makeFile(`import { cn } from '~/lib/utils'`)
    const project = makeProject({ packageJson: {} })
    const findings = hallucinatedImportsRule.check(file, project)
    expect(findings).toHaveLength(0)
  })

  it('allows tsconfig path aliases', () => {
    const file = makeFile(`import { Button } from '@components/button'`)
    const project = makeProject({
      packageJson: {},
      tsconfigPaths: new Set(['@components']),
    })
    const findings = hallucinatedImportsRule.check(file, project)
    expect(findings).toHaveLength(0)
  })

  // With a `baseUrl`, TypeScript looks an import up under that folder before node_modules:
  // `src/settings` is src/settings.ts and `main` is main.ts
  describe('tsconfig baseUrl', () => {
    type TsconfigScope = import('../../src/types.js').TsconfigScope
    const scope = (overrides: Partial<TsconfigScope> = {}): TsconfigScope => ({
      paths: new Set(),
      baseUrl: '',
      baseUrlFolders: new Set(['src', 'config']),
      baseUrlModules: new Set(['main', 'main.ts', 'styles.css', 'hooks']),
      ...overrides,
    })
    const messages = (code: string, tsconfigs: [string, TsconfigScope][], opts: Parameters<typeof makeFile>[1] = {}) =>
      hallucinatedImportsRule
        .check(makeFile(code, opts), makeProject({ packageJson: {}, tsconfigs: new Map(tsconfigs) }))
        .map(f => f.message)

    it('allows an import into a folder under baseUrl', () => {
      expect(messages(`import { Settings } from 'src/settings'\nimport defaults from 'config/default.json'`, [['', scope()]])).toEqual([])
    })

    it('allows an import of a file under baseUrl, with or without its extension', () => {
      expect(messages(`import Plugin from 'main'\nimport 'styles.css'\nimport again from 'main.js'`, [['', scope()]])).toEqual([])
    })

    it('allows an import of a folder with an index', () => {
      expect(messages(`import { useThing } from 'hooks'`, [['', scope()]])).toEqual([])
    })

    it('still flags a package that is not under baseUrl', () => {
      expect(messages(`import x from 'lodahs'\nimport { y } from '@acme/missing'\nimport z from 'lodahs/fp'`, [['', scope()]])).toEqual([
        'Package "lodahs" is imported but not in package.json',
        'Package "@acme/missing" is imported but not in package.json',
      ])
    })

    it('still flags one segment that names a folder without an index: TypeScript looks in node_modules for it', () => {
      expect(messages(`import config from 'config'`, [['', scope()]])).toEqual(['Package "config" is imported but not in package.json'])
    })

    // As for any name: a file's first import of it decides, so the change can't add a finding
    it("lets a file's first import of a name decide, as before", () => {
      const flagged = ['Package "config" is imported but not in package.json']
      expect(messages(`import config from 'config'\nimport { db } from 'config/database'`, [['', scope()]])).toEqual(flagged)
      expect(messages(`import { db } from 'config/database'\nimport config from 'config'`, [['', scope()]])).toEqual([])
      expect(messages(`import { db } from 'config/database'\nimport config from 'config'`, [['', scope()]], { withAst: false })).toEqual([])
    })

    it('flags the same imports when the config has no baseUrl', () => {
      expect(messages(`import { Settings } from 'src/settings'\nimport Plugin from 'main'`, [['', scope({ baseUrl: null })]])).toEqual([
        'Package "src" is imported but not in package.json',
        'Package "main" is imported but not in package.json',
      ])
    })

    it('reads a folder named like a scope as a folder', () => {
      const tsconfig = scope({ baseUrlFolders: new Set(['@core']) })
      expect(messages(`import { Auth } from '@core/services/auth'\nimport { x } from '@other/pkg'`, [['', tsconfig]])).toEqual([
        'Package "@other/pkg" is imported but not in package.json',
      ])
    })

    it('judges a file by the config nearest above it', () => {
      const tsconfigs: [string, TsconfigScope][] = [
        ['', scope({ baseUrl: null, baseUrlFolders: new Set(), baseUrlModules: new Set() })],
        ['apps/web', scope({ baseUrl: 'apps/web', baseUrlFolders: new Set(['components']), baseUrlModules: new Set() })],
      ]
      const code = `import { Button } from 'components/button'`

      expect(messages(code, tsconfigs, { relativePath: 'apps/web/app/page.tsx' })).toEqual([])
      expect(messages(code, tsconfigs, { relativePath: 'apps/api/main.ts' })).toEqual(['Package "components" is imported but not in package.json'])
      expect(messages(code, tsconfigs, { relativePath: 'index.ts' })).toEqual(['Package "components" is imported but not in package.json'])
    })

    it("doesn't give a nested config the baseUrl of the one above it", () => {
      const tsconfigs: [string, TsconfigScope][] = [
        ['', scope()],
        ['functions', scope({ baseUrl: null, baseUrlFolders: new Set(), baseUrlModules: new Set() })],
      ]
      expect(messages(`import { Settings } from 'src/settings'`, tsconfigs, { relativePath: 'functions/index.ts' })).toEqual([
        'Package "src" is imported but not in package.json',
      ])
    })

    it("allows the paths of a file's own config, and only for the files under it", () => {
      const tsconfigs: [string, TsconfigScope][] = [
        ['apps/web', scope({ baseUrl: null, paths: new Set(['$lib', 'styled-system']) })],
      ]
      const code = `import { db } from '$lib/db'\nimport { css } from 'styled-system/css'`

      expect(messages(code, tsconfigs, { relativePath: 'apps/web/src/routes/page.ts' })).toEqual([])
      expect(messages(code, tsconfigs, { relativePath: 'apps/api/main.ts' })).toEqual([
        'Package "$lib" is imported but not in package.json',
        'Package "styled-system" is imported but not in package.json',
      ])
    })

    it('reads require() and import() the same way', () => {
      expect(messages(`const a = require('src/a')\nconst b = await import('src/b')\nconst c = require('nope/c')`, [['', scope()]])).toEqual([
        'Package "nope" is imported but not in package.json',
      ])
    })

    it('applies without a syntax tree too', () => {
      const code = `import { Settings } from 'src/settings'\nimport Plugin from 'main'\nimport x from 'lodahs'`
      expect(messages(code, [['', scope()]], { withAst: false })).toEqual(['Package "lodahs" is imported but not in package.json'])
    })
  })

  // Through the scanner: the configs are read from disk, comments and all
  describe('tsconfig files in a scan', () => {
    const scanned = async (files: Record<string, string>) =>
      (await scanFiles(files)).findings.filter(f => f.ruleId === 'hallucinated-imports').map(f => `${f.file}: ${f.message}`)
    const json = (value: unknown) => JSON.stringify(value, null, 2)

    it('resolves an import under baseUrl against what exists', async () => {
      expect(await scanned({
        'package.json': json({ name: 'plugin', dependencies: { obsidian: '^1.0.0' } }),
        'tsconfig.json': json({ compilerOptions: { baseUrl: '.' } }),
        'main.ts': "import { Plugin } from 'obsidian'\nimport { Settings } from 'src/settings'\nimport { helper } from 'lib/helper'\nimport x from 'lodahs'\n\nexport default class extends Plugin { s = new Settings(helper(x)) }\n",
        'src/settings.ts': "import Plugin from 'main'\nimport missing from 'mian'\n\nexport class Settings { p = Plugin; m = missing }\n",
      })).toEqual([
        'main.ts: Package "lib" is imported but not in package.json',
        'main.ts: Package "lodahs" is imported but not in package.json',
        'src/settings.ts: Package "mian" is imported but not in package.json',
      ])
    })

    it('reads baseUrl relative to the tsconfig, and counts folders the scan does not walk', async () => {
      expect(await scanned({
        'package.json': json({ name: 'app' }),
        'tsconfig.json': json({ compilerOptions: { baseUrl: './src' } }),
        'src/index.tsx': "import 'styles/global.css'\nimport logo from 'assets/logo.svg'\nimport type { User } from 'types'\nimport { App } from 'components/App'\nimport { nope } from 'src/components/App'\n\nexport const x = [logo, App, nope] as User[]\n",
        'src/components/App.tsx': 'export const App = () => null\n',
        'src/styles/global.css': 'body { margin: 0 }\n',
        'src/assets/logo.svg': '<svg/>\n',
        'src/types/index.d.ts': 'export interface User { id: string }\n',
      })).toEqual(['src/index.tsx: Package "src" is imported but not in package.json'])
    })

    it('reads a tsconfig with block comments, trailing commas and a URL', async () => {
      const tsconfig = [
        '{',
        '  "$schema": "https://json.schemastore.org/tsconfig",',
        '  "compilerOptions": {',
        '    /* Path Aliases */',
        '    "baseUrl": ".",',
        '    "paths": {',
        '      "@server/*": ["./server/*"], // the API',
        '    },',
        '  },',
        '}',
      ].join('\n')

      expect(await scanned({
        'package.json': json({ name: 'app' }),
        'tsconfig.json': tsconfig,
        'app/page.ts': "import { db } from '@server/db'\nimport { fmt } from 'lib/format'\nimport { x } from 'left-pad'\n\nexport const page = [db, fmt, x]\n",
        'lib/format.ts': 'export const fmt = String\n',
        'server/db.ts': 'export const db = {}\n',
      })).toEqual(['app/page.ts: Package "left-pad" is imported but not in package.json'])
    })

    it('judges each file by the tsconfig nearest above it', async () => {
      expect(await scanned({
        'package.json': json({ name: 'repo', private: true }),
        'apps/web/package.json': json({ name: 'web' }),
        'apps/web/tsconfig.json': json({ compilerOptions: { baseUrl: '.', paths: { '@ui/*': ['components/ui/*'] } } }),
        'apps/web/pages/index.tsx': "import { Button } from 'components/button'\nimport { Card } from '@ui/card'\n\nexport default () => [Button, Card]\n",
        'apps/web/components/button.tsx': 'export const Button = () => null\n',
        'apps/web/components/ui/card.tsx': 'export const Card = () => null\n',
        'apps/api/package.json': json({ name: 'api' }),
        'apps/api/tsconfig.json': json({ compilerOptions: { strict: true } }),
        'apps/api/main.ts': "import { Button } from 'components/button'\nimport { Card } from '@ui/card'\n\nexport default [Button, Card]\n",
        'tools/build.ts': "import { Button } from 'components/button'\n\nexport default Button\n",
      })).toEqual([
        'apps/api/main.ts: Package "components" is imported but not in package.json',
        'apps/api/main.ts: Package "@ui/card" is imported but not in package.json',
        'tools/build.ts: Package "components" is imported but not in package.json',
      ])
    })

    it('follows a relative extends: test/tsconfig.json has the baseUrl and paths of the root', async () => {
      expect(await scanned({
        'package.json': json({ name: 'api' }),
        'tsconfig.json': json({ compilerOptions: { baseUrl: './', paths: { '~shared/*': ['shared/*'] } } }),
        'src/app.module.ts': 'export class AppModule {}\n',
        'shared/dto.ts': 'export class Dto {}\n',
        'e2e/tsconfig.json': json({ extends: '../tsconfig.json', compilerOptions: { types: ['jest'] } }),
        'e2e/app.ts': "import { AppModule } from 'src/app.module'\nimport { Dto } from '~shared/dto'\nimport request from 'supertest'\n\nexport default [AppModule, Dto, request]\n",
        'cli/tsconfig.json': json({ compilerOptions: { types: ['node'] } }),
        'cli/run.ts': "import { AppModule } from 'src/app.module'\n\nexport default AppModule\n",
      })).toEqual([
        'cli/run.ts: Package "src" is imported but not in package.json',
        'e2e/app.ts: Package "supertest" is imported but not in package.json',
      ])
    })

    it('reads a jsconfig.json in a JavaScript project', async () => {
      expect(await scanned({
        'package.json': json({ name: 'site' }),
        'jsconfig.json': '{\n  "compilerOptions": {\n    "baseUrl": "src",\n  },\n}\n',
        'src/pages/index.js': "import Layout from 'components/Layout'\nimport nope from 'componentz/Layout'\n\nexport default () => [Layout, nope]\n",
        'src/components/Layout.js': 'export default () => null\n',
      })).toEqual(['src/pages/index.js: Package "componentz" is imported but not in package.json'])
    })

    it("keeps the root tsconfig's paths for every file, as before", async () => {
      expect(await scanned({
        'package.json': json({ name: 'repo' }),
        'tsconfig.json': json({ compilerOptions: { paths: { '@shared/*': ['shared/*'] } } }),
        'shared/x.ts': 'export const x = 1\n',
        'apps/web/tsconfig.json': json({ compilerOptions: { strict: true } }),
        'apps/web/index.ts': "import { x } from '@shared/x'\n\nexport default x\n",
      })).toEqual([])
    })
  })

  it('skips relative imports', () => {
    const file = makeFile(`import { foo } from './foo'`)
    const project = makeProject({ packageJson: {} })
    const findings = hallucinatedImportsRule.check(file, project)
    expect(findings).toHaveLength(0)
  })

  it('handles scoped packages', () => {
    const file = makeFile(`import { Ratelimit } from '@upstash/ratelimit'`)
    const project = makeProject({ packageJson: {} })
    const findings = hallucinatedImportsRule.check(file, project)
    expect(findings).toHaveLength(1)
    expect(findings[0].message).toContain('@upstash/ratelimit')
  })

  it('allows declared scoped packages', () => {
    const file = makeFile(`import { Ratelimit } from '@upstash/ratelimit'`)
    const project = makeProject({
      packageJson: {},
      declaredDependencies: new Set(['@upstash/ratelimit']),
    })
    const findings = hallucinatedImportsRule.check(file, project)
    expect(findings).toHaveLength(0)
  })

  it('handles require() calls', () => {
    const file = makeFile(`const pkg = require('missing-pkg')`)
    const project = makeProject({ packageJson: {} })
    const findings = hallucinatedImportsRule.check(file, project)
    expect(findings).toHaveLength(1)
  })

  it('skips commented imports', () => {
    const file = makeFile(`// import { foo } from 'missing-pkg'`)
    const project = makeProject({ packageJson: {} })
    const findings = hallucinatedImportsRule.check(file, project)
    expect(findings).toHaveLength(0)
  })

  it('returns empty when no package.json', () => {
    const file = makeFile(`import { foo } from 'missing-pkg'`)
    const project = makeProject({ packageJson: null })
    const findings = hallucinatedImportsRule.check(file, project)
    expect(findings).toHaveLength(0)
  })

  it('deduplicates findings for same package', () => {
    const file = makeFile(`import { a } from 'missing-pkg'\nimport { b } from 'missing-pkg'`)
    const project = makeProject({ packageJson: {} })
    const findings = hallucinatedImportsRule.check(file, project)
    expect(findings).toHaveLength(1)
  })

  it('downgrades severity to warning for test files', () => {
    const file = makeFile(`import { foo } from 'missing-pkg'`, { relativePath: 'tests/foo.test.ts' })
    const project = makeProject({ packageJson: {} })
    const findings = hallucinatedImportsRule.check(file, project)
    expect(findings).toHaveLength(1)
    expect(findings[0].severity).toBe('warning')
  })

  it('downgrades severity to warning for script files', () => {
    const file = makeFile(`import { foo } from 'missing-pkg'`, { relativePath: 'scripts/seed.ts' })
    const project = makeProject({ packageJson: {} })
    const findings = hallucinatedImportsRule.check(file, project)
    expect(findings).toHaveLength(1)
    expect(findings[0].severity).toBe('warning')
  })

  it('keeps critical severity for production code', () => {
    const file = makeFile(`import { foo } from 'missing-pkg'`)
    const project = makeProject({ packageJson: {} })
    const findings = hallucinatedImportsRule.check(file, project)
    expect(findings).toHaveLength(1)
    expect(findings[0].severity).toBe('critical')
  })

  it('does not flag import-like string inside template literal (AST path)', () => {
    const file = makeFile([
      `const msg = \`Use import { x } from 'fake-pkg' for this\``,
    ].join('\n'))
    const project = makeProject({ packageJson: {} })
    const findings = hallucinatedImportsRule.check(file, project)
    expect(findings).toHaveLength(0)
  })

  it('flags dynamic import() of missing package (AST path)', () => {
    const file = makeFile(`const mod = await import('missing-dynamic-pkg')`)
    const project = makeProject({ packageJson: {} })
    const findings = hallucinatedImportsRule.check(file, project)
    expect(findings).toHaveLength(1)
    expect(findings[0].message).toContain('missing-dynamic-pkg')
  })

  it('falls back to regex when AST unavailable', () => {
    const file = makeFile(`import { foo } from 'missing-pkg'`, { withAst: false })
    const project = makeProject({ packageJson: {} })
    const findings = hallucinatedImportsRule.check(file, project)
    expect(findings).toHaveLength(1)
    expect(findings[0].message).toContain('missing-pkg')
  })

  it('allows workspace package name as declared dependency', () => {
    const file = makeFile(`import { utils } from '@myorg/shared'`)
    const project = makeProject({
      packageJson: {},
      declaredDependencies: new Set(['@myorg/shared']),
    })
    const findings = hallucinatedImportsRule.check(file, project)
    expect(findings).toHaveLength(0)
  })
})
