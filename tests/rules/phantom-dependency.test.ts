import { describe, it, expect } from 'vitest'
import { phantomDependencyRule } from '../../src/rules/phantom-dependency.js'
import { makeFile, makeProject } from '../helpers.js'

describe('phantom-dependency rule', () => {
  it('flags known hallucinated package', () => {
    const project = makeProject({
      packageJson: {
        dependencies: { 'openai-sdk': '^1.0.0' },
      },
    })
    const findings = phantomDependencyRule.checkProject!([], project)
    expect(findings).toHaveLength(1)
    expect(findings[0].message).toContain('openai-sdk')
    expect(findings[0].message).toContain('hallucinated')
  })

  it('flags another hallucinated package', () => {
    const project = makeProject({
      packageJson: {
        devDependencies: { 'supabase-client': '^2.0.0' },
      },
    })
    const findings = phantomDependencyRule.checkProject!([], project)
    expect(findings).toHaveLength(1)
    expect(findings[0].message).toContain('supabase-client')
  })

  it('flags suspicious 1-2 char package name', () => {
    const project = makeProject({
      packageJson: {
        dependencies: { 'ab': '^1.0.0' },
      },
    })
    const findings = phantomDependencyRule.checkProject!([], project)
    expect(findings.some(f => f.message.includes('suspicious'))).toBe(true)
  })

  it('flags suspicious -js suffix', () => {
    const project = makeProject({
      packageJson: {
        dependencies: { 'leftpad-js': '^1.0.0' },
      },
    })
    const findings = phantomDependencyRule.checkProject!([], project)
    expect(findings.some(f => f.message.includes('suspicious'))).toBe(true)
  })

  it('does not flag scoped packages with suspicious patterns', () => {
    const project = makeProject({
      packageJson: {
        dependencies: { '@types/ab': '^1.0.0' },
      },
    })
    const findings = phantomDependencyRule.checkProject!([], project)
    expect(findings).toHaveLength(0)
  })

  it('allows legitimate packages', () => {
    const project = makeProject({
      packageJson: {
        dependencies: {
          'react': '^18.0.0',
          'next': '^14.0.0',
          '@supabase/supabase-js': '^2.0.0',
          'stripe': '^14.0.0',
        },
      },
    })
    const findings = phantomDependencyRule.checkProject!([], project)
    expect(findings).toHaveLength(0)
  })

  it('returns empty when no package.json', () => {
    const project = makeProject({ packageJson: null })
    const findings = phantomDependencyRule.checkProject!([], project)
    expect(findings).toHaveLength(0)
  })
})
