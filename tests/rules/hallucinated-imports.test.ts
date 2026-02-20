import { describe, it, expect } from 'vitest'
import { hallucinatedImportsRule } from '../../src/rules/hallucinated-imports.js'
import { makeFile, makeProject } from '../helpers.js'

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
