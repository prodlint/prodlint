import { describe, it, expect } from 'vitest'
import { missingErrorBoundaryRule } from '../../src/rules/missing-error-boundary.js'
import { makeFile, makeProject } from '../helpers.js'

describe('missing-error-boundary rule', () => {
  it('detects layout without error.tsx', () => {
    const project = makeProject({
      allFiles: ['app/dashboard/layout.tsx', 'app/dashboard/page.tsx'],
    })
    const file = makeFile('export default function Layout({ children }) { return children }', {
      relativePath: 'app/dashboard/layout.tsx',
      ext: 'tsx',
    })
    const findings = missingErrorBoundaryRule.check(file, project)
    expect(findings).toHaveLength(1)
    expect(findings[0].message).toContain('error.tsx')
  })

  it('ignores layout with matching error.tsx', () => {
    const project = makeProject({
      allFiles: ['app/dashboard/layout.tsx', 'app/dashboard/error.tsx'],
    })
    const file = makeFile('export default function Layout({ children }) { return children }', {
      relativePath: 'app/dashboard/layout.tsx',
      ext: 'tsx',
    })
    const findings = missingErrorBoundaryRule.check(file, project)
    expect(findings).toHaveLength(0)
  })

  it('ignores root layout', () => {
    const project = makeProject({
      allFiles: ['app/layout.tsx'],
    })
    const file = makeFile('export default function RootLayout({ children }) { return children }', {
      relativePath: 'app/layout.tsx',
      ext: 'tsx',
    })
    const findings = missingErrorBoundaryRule.check(file, project)
    expect(findings).toHaveLength(0)
  })

  it('ignores non-layout files', () => {
    const project = makeProject({ allFiles: ['app/dashboard/page.tsx'] })
    const file = makeFile('export default function Page() { return <div/> }', {
      relativePath: 'app/dashboard/page.tsx',
      ext: 'tsx',
    })
    const findings = missingErrorBoundaryRule.check(file, project)
    expect(findings).toHaveLength(0)
  })

  it('detects deeply nested layout without error.tsx', () => {
    const project = makeProject({
      allFiles: ['app/admin/settings/layout.tsx', 'app/admin/settings/page.tsx'],
    })
    const file = makeFile('export default function Layout({ children }) { return children }', {
      relativePath: 'app/admin/settings/layout.tsx',
      ext: 'tsx',
    })
    const findings = missingErrorBoundaryRule.check(file, project)
    expect(findings).toHaveLength(1)
  })

  it('accepts error.jsx as a match', () => {
    const project = makeProject({
      allFiles: ['app/dashboard/layout.tsx', 'app/dashboard/error.jsx'],
    })
    const file = makeFile('export default function Layout({ children }) { return children }', {
      relativePath: 'app/dashboard/layout.tsx',
      ext: 'tsx',
    })
    const findings = missingErrorBoundaryRule.check(file, project)
    expect(findings).toHaveLength(0)
  })

  it('detects src/app/ layout without error.tsx', () => {
    const project = makeProject({
      allFiles: ['src/app/dashboard/layout.tsx', 'src/app/dashboard/page.tsx'],
    })
    const file = makeFile('export default function Layout({ children }) { return children }', {
      relativePath: 'src/app/dashboard/layout.tsx',
      ext: 'tsx',
    })
    const findings = missingErrorBoundaryRule.check(file, project)
    expect(findings).toHaveLength(1)
    expect(findings[0].message).toContain('error.tsx')
  })

  it('ignores src/app/ layout with matching error.tsx', () => {
    const project = makeProject({
      allFiles: ['src/app/dashboard/layout.tsx', 'src/app/dashboard/error.tsx'],
    })
    const file = makeFile('export default function Layout({ children }) { return children }', {
      relativePath: 'src/app/dashboard/layout.tsx',
      ext: 'tsx',
    })
    const findings = missingErrorBoundaryRule.check(file, project)
    expect(findings).toHaveLength(0)
  })
})
