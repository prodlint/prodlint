import { describe, it, expect } from 'vitest'
import { serverComponentFetchSelfRule } from '../../src/rules/server-component-fetch-self.js'
import { makeFile, makeProject } from '../helpers.js'

const project = makeProject()

describe('server-component-fetch-self rule', () => {
  it('detects fetch to own /api/ in server component', () => {
    const file = makeFile(`export default async function Page() {
  const res = await fetch('/api/users')
  const users = await res.json()
  return <div>{users.length}</div>
}`, { relativePath: 'app/page.tsx' })
    const findings = serverComponentFetchSelfRule.check(file, project)
    expect(findings).toHaveLength(1)
    expect(findings[0].ruleId).toBe('server-component-fetch-self')
  })

  it('detects fetch to localhost in server component', () => {
    const file = makeFile(`export default async function Page() {
  const res = await fetch('http://localhost:3000/api/data')
  return <div />
}`, { relativePath: 'app/dashboard/page.tsx' })
    const findings = serverComponentFetchSelfRule.check(file, project)
    expect(findings).toHaveLength(1)
  })

  it('allows fetch in client components', () => {
    const file = makeFile(`'use client'
export default function Page() {
  useEffect(() => { fetch('/api/users') }, [])
  return <div />
}`, { relativePath: 'app/page.tsx' })
    const findings = serverComponentFetchSelfRule.check(file, project)
    expect(findings).toHaveLength(0)
  })

  it('ignores API routes', () => {
    const file = makeFile(`const res = await fetch('/api/other')`, { relativePath: 'app/api/proxy/route.ts' })
    const findings = serverComponentFetchSelfRule.check(file, project)
    expect(findings).toHaveLength(0)
  })

  it('ignores files outside app directory', () => {
    const file = makeFile(`const res = await fetch('/api/users')`, { relativePath: 'lib/data.ts' })
    const findings = serverComponentFetchSelfRule.check(file, project)
    expect(findings).toHaveLength(0)
  })
})
