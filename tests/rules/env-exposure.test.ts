import { describe, it, expect } from 'vitest'
import { envExposureRule } from '../../src/rules/env-exposure.js'
import { makeFile, makeProject } from '../helpers.js'

describe('env-exposure rule', () => {
  it('flags .env not in .gitignore', () => {
    const file = makeFile(`node_modules/\ndist/`, { relativePath: '.gitignore' })
    const project = makeProject({ envInGitignore: false })
    const findings = envExposureRule.check(file, project)
    expect(findings).toHaveLength(1)
    expect(findings[0].message).toContain('.env')
  })

  it('passes when .env is in .gitignore', () => {
    const file = makeFile(`node_modules/\n.env`, { relativePath: '.gitignore' })
    const project = makeProject({ envInGitignore: true })
    const findings = envExposureRule.check(file, project)
    expect(findings).toHaveLength(0)
  })

  it('flags server env var in client component', () => {
    const file = makeFile(
      `"use client"\nconst url = process.env.DATABASE_URL`,
      { relativePath: 'app/components/db.tsx', ext: 'tsx' },
    )
    const findings = envExposureRule.check(file, makeProject())
    expect(findings).toHaveLength(1)
    expect(findings[0].severity).toBe('critical')
    expect(findings[0].message).toContain('DATABASE_URL')
  })

  it('allows NEXT_PUBLIC_ env vars in client components', () => {
    const file = makeFile(
      `"use client"\nconst url = process.env.NEXT_PUBLIC_API_URL`,
      { relativePath: 'app/components/api.tsx', ext: 'tsx' },
    )
    const findings = envExposureRule.check(file, makeProject())
    expect(findings).toHaveLength(0)
  })

  it('allows server env vars in server components', () => {
    const file = makeFile(
      `const url = process.env.DATABASE_URL`,
      { relativePath: 'app/page.tsx', ext: 'tsx' },
    )
    const findings = envExposureRule.check(file, makeProject())
    expect(findings).toHaveLength(0)
  })

  it('reports warning for non-sensitive server vars in client', () => {
    const file = makeFile(
      `"use client"\nconst val = process.env.CUSTOM_CONFIG`,
      { relativePath: 'app/components/config.tsx', ext: 'tsx' },
    )
    const findings = envExposureRule.check(file, makeProject())
    expect(findings).toHaveLength(1)
    expect(findings[0].severity).toBe('warning')
  })

  it('skips env vars in comments', () => {
    const file = makeFile(
      `"use client"\n// process.env.DATABASE_URL`,
      { relativePath: 'app/components/db.tsx', ext: 'tsx' },
    )
    const findings = envExposureRule.check(file, makeProject())
    expect(findings).toHaveLength(0)
  })

  it('skips non-ts/tsx files', () => {
    const file = makeFile(
      `"use client"\nprocess.env.DATABASE_URL`,
      { relativePath: 'readme.md', ext: 'md' },
    )
    const findings = envExposureRule.check(file, makeProject())
    expect(findings).toHaveLength(0)
  })

  it('detects multiple env vars on different lines', () => {
    const file = makeFile(
      `"use client"\nconst a = process.env.STRIPE_SECRET_KEY\nconst b = process.env.JWT_SECRET`,
      { relativePath: 'app/comp.tsx', ext: 'tsx' },
    )
    const findings = envExposureRule.check(file, makeProject())
    expect(findings).toHaveLength(2)
  })
})
