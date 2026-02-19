import { describe, it, expect } from 'vitest'
import { hydrationMismatchRule } from '../../src/rules/hydration-mismatch.js'
import { makeFile, makeProject } from '../helpers.js'

const project = makeProject()

describe('hydration-mismatch rule', () => {
  it('detects window access in server component', () => {
    const file = makeFile(`export default function Page() {
  const width = window.innerWidth
  return <div>{width}</div>
}`, { relativePath: 'app/page.tsx' })
    const findings = hydrationMismatchRule.check(file, project)
    expect(findings).toHaveLength(1)
    expect(findings[0].ruleId).toBe('hydration-mismatch')
  })

  it('detects new Date() in server component render', () => {
    const file = makeFile(`export default function Page() {
  const now = new Date()
  return <div>{now.toISOString()}</div>
}`, { relativePath: 'app/page.tsx' })
    const findings = hydrationMismatchRule.check(file, project)
    expect(findings).toHaveLength(1)
  })

  it('detects localStorage in server component', () => {
    const file = makeFile(`export default function Page() {
  const token = localStorage.getItem('token')
  return <div>{token}</div>
}`, { relativePath: 'app/page.tsx' })
    const findings = hydrationMismatchRule.check(file, project)
    expect(findings).toHaveLength(1)
  })

  it('allows browser APIs in client components', () => {
    const file = makeFile(`'use client'
export default function Page() {
  const width = window.innerWidth
  return <div>{width}</div>
}`, { relativePath: 'app/components/size.tsx' })
    const findings = hydrationMismatchRule.check(file, project)
    expect(findings).toHaveLength(0)
  })

  it('ignores files outside app directory', () => {
    const file = makeFile(`const w = window.innerWidth`, { relativePath: 'lib/utils.ts' })
    const findings = hydrationMismatchRule.check(file, project)
    expect(findings).toHaveLength(0)
  })

  it('ignores API routes', () => {
    const file = makeFile(`const d = new Date()`, { relativePath: 'app/api/test/route.ts' })
    const findings = hydrationMismatchRule.check(file, project)
    expect(findings).toHaveLength(0)
  })

  it('detects Math.random in server render', () => {
    const file = makeFile(`export default function Page() {
  const id = Math.random()
  return <div id={id} />
}`, { relativePath: 'app/page.tsx' })
    const findings = hydrationMismatchRule.check(file, project)
    expect(findings).toHaveLength(1)
  })
})
