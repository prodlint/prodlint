import { describe, it, expect } from 'vitest'
import { missingUseEffectCleanupRule } from '../../src/rules/missing-useeffect-cleanup.js'
import { makeFile, makeProject } from '../helpers.js'

const project = makeProject()

describe('missing-useeffect-cleanup rule', () => {
  it('detects setInterval without cleanup', () => {
    const file = makeFile(`'use client'
import { useEffect } from 'react'
function Timer() {
  useEffect(() => {
    setInterval(() => tick(), 1000)
  }, [])
  return <div />
}`, { relativePath: 'components/timer.tsx' })
    const findings = missingUseEffectCleanupRule.check(file, project)
    expect(findings).toHaveLength(1)
    expect(findings[0].ruleId).toBe('missing-useeffect-cleanup')
  })

  it('detects addEventListener without cleanup', () => {
    const file = makeFile(`'use client'
import { useEffect } from 'react'
function Scroller() {
  useEffect(() => {
    window.addEventListener('scroll', handler)
  }, [])
  return <div />
}`, { relativePath: 'components/scroller.tsx' })
    const findings = missingUseEffectCleanupRule.check(file, project)
    expect(findings).toHaveLength(1)
  })

  it('allows useEffect with cleanup return', () => {
    const file = makeFile(`'use client'
import { useEffect } from 'react'
function Timer() {
  useEffect(() => {
    const id = setInterval(() => tick(), 1000)
    return () => clearInterval(id)
  }, [])
  return <div />
}`, { relativePath: 'components/timer.tsx' })
    const findings = missingUseEffectCleanupRule.check(file, project)
    expect(findings).toHaveLength(0)
  })

  it('ignores useEffect without subscriptions', () => {
    const file = makeFile(`'use client'
import { useEffect } from 'react'
function Logger() {
  useEffect(() => {
    console.log('mounted')
  }, [])
  return <div />
}`, { relativePath: 'components/logger.tsx' })
    const findings = missingUseEffectCleanupRule.check(file, project)
    expect(findings).toHaveLength(0)
  })

  it('ignores non-client components', () => {
    const file = makeFile(`
import { useEffect } from 'react'
function Timer() {
  useEffect(() => {
    setInterval(() => tick(), 1000)
  }, [])
}`, { relativePath: 'components/timer.tsx' })
    const findings = missingUseEffectCleanupRule.check(file, project)
    expect(findings).toHaveLength(0)
  })
})
