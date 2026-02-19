import { describe, it, expect } from 'vitest'
import { useClientOveruseRule } from '../../src/rules/use-client-overuse.js'
import { makeFile, makeProject } from '../helpers.js'

const project = makeProject()

describe('use-client-overuse rule', () => {
  it('detects "use client" with no client APIs', () => {
    const file = makeFile(`'use client'
export function Card({ title }) {
  return <div>{title}</div>
}`, { relativePath: 'components/card.tsx' })
    const findings = useClientOveruseRule.check(file, project)
    expect(findings).toHaveLength(1)
    expect(findings[0].ruleId).toBe('use-client-overuse')
  })

  it('allows "use client" with useState', () => {
    const file = makeFile(`'use client'
import { useState } from 'react'
export function Counter() {
  const [count, setCount] = useState(0)
  return <button onClick={() => setCount(c => c + 1)}>{count}</button>
}`, { relativePath: 'components/counter.tsx' })
    const findings = useClientOveruseRule.check(file, project)
    expect(findings).toHaveLength(0)
  })

  it('allows "use client" with onClick handler', () => {
    const file = makeFile(`'use client'
export function Button({ onAction }) {
  return <button onClick={onAction}>Click</button>
}`, { relativePath: 'components/button.tsx' })
    const findings = useClientOveruseRule.check(file, project)
    expect(findings).toHaveLength(0)
  })

  it('allows "use client" with useEffect', () => {
    const file = makeFile(`'use client'
import { useEffect } from 'react'
export function Tracker() {
  useEffect(() => { console.log('mounted') }, [])
  return <div />
}`, { relativePath: 'components/tracker.tsx' })
    const findings = useClientOveruseRule.check(file, project)
    expect(findings).toHaveLength(0)
  })

  it('ignores files without "use client"', () => {
    const file = makeFile(`export function Card({ title }) {
  return <div>{title}</div>
}`, { relativePath: 'components/card.tsx' })
    const findings = useClientOveruseRule.check(file, project)
    expect(findings).toHaveLength(0)
  })

  it('ignores test files', () => {
    const file = makeFile(`'use client'
export function Card() { return <div /> }`, { relativePath: 'tests/card.test.tsx' })
    const findings = useClientOveruseRule.check(file, project)
    expect(findings).toHaveLength(0)
  })

  it('allows "use client" with window access', () => {
    const file = makeFile(`'use client'
export function Width() {
  return <div>{window.innerWidth}</div>
}`, { relativePath: 'components/width.tsx' })
    const findings = useClientOveruseRule.check(file, project)
    expect(findings).toHaveLength(0)
  })
})
