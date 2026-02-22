import { describe, it, expect } from 'vitest'
import { missingAbortControllerRule } from '../../src/rules/missing-abort-controller.js'
import { makeFile, makeProject } from '../helpers.js'

const project = makeProject()

describe('missing-abort-controller rule', () => {
  it('detects fetch without timeout in API route', () => {
    const file = makeFile(`export async function GET(req) {
  const res = await fetch('https://api.example.com/data')
  return Response.json(await res.json())
}`, { relativePath: 'app/api/proxy/route.ts' })
    const findings = missingAbortControllerRule.check(file, project)
    expect(findings).toHaveLength(1)
    expect(findings[0].ruleId).toBe('missing-abort-controller')
  })

  it('allows fetch with AbortController', () => {
    const file = makeFile(`export async function GET(req) {
  const controller = new AbortController()
  setTimeout(() => controller.abort(), 5000)
  const res = await fetch('https://api.example.com/data', { signal: controller.signal })
}`, { relativePath: 'app/api/proxy/route.ts' })
    const findings = missingAbortControllerRule.check(file, project)
    expect(findings).toHaveLength(0)
  })

  it('allows fetch with timeout option', () => {
    const file = makeFile(`export async function GET(req) {
  const res = await fetch('https://api.example.com/data', { timeout: 5000 })
}`, { relativePath: 'app/api/proxy/route.ts' })
    const findings = missingAbortControllerRule.check(file, project)
    expect(findings).toHaveLength(0)
  })

  it('ignores non-API files', () => {
    const file = makeFile(`const res = await fetch('https://api.example.com')`, { relativePath: 'lib/api.ts' })
    const findings = missingAbortControllerRule.check(file, project)
    expect(findings).toHaveLength(0)
  })

  it('checks server actions', () => {
    const file = makeFile(`'use server'
export async function getData() {
  const res = await fetch('https://api.example.com/data')
  return res.json()
}`, { relativePath: 'actions/data.ts' })
    const findings = missingAbortControllerRule.check(file, project)
    expect(findings).toHaveLength(1)
  })

  it('ignores files without fetch', () => {
    const file = makeFile(`export async function GET(req) {
  return Response.json({ ok: true })
}`, { relativePath: 'app/api/health/route.ts' })
    const findings = missingAbortControllerRule.check(file, project)
    expect(findings).toHaveLength(0)
  })

  it('detects axios call without timeout in API route', () => {
    const file = makeFile(`export async function GET(req) {
  const res = await axios.get('https://api.example.com/data')
  return Response.json(res.data)
}`, { relativePath: 'app/api/proxy/route.ts' })
    const findings = missingAbortControllerRule.check(file, project)
    expect(findings).toHaveLength(1)
    expect(findings[0].message).toContain('axios()')
  })

  it('allows axios.create with timeout config', () => {
    const file = makeFile(`const client = axios.create({ baseURL: 'https://api.example.com', timeout: 5000 })
export async function GET(req) {
  const res = await client.get('/data')
  return Response.json(res.data)
}`, { relativePath: 'app/api/proxy/route.ts' })
    const findings = missingAbortControllerRule.check(file, project)
    expect(findings).toHaveLength(0)
  })

  it('detects fetch in background job file without timeout', () => {
    const file = makeFile(`import { queue } from './queue'
queue.process(async (job) => {
  const res = await fetch('https://api.example.com/webhook')
  console.log(await res.json())
})`, { relativePath: 'workers/notify.ts' })
    const findings = missingAbortControllerRule.check(file, project)
    expect(findings).toHaveLength(1)
  })

  it('allows cron handler with AbortController', () => {
    const file = makeFile(`import cron from 'node-cron'
cron.schedule('* * * * *', async () => {
  const controller = new AbortController()
  setTimeout(() => controller.abort(), 5000)
  await fetch('https://api.example.com', { signal: controller.signal })
})`, { relativePath: 'jobs/sync.ts' })
    const findings = missingAbortControllerRule.check(file, project)
    expect(findings).toHaveLength(0)
  })

  it('detects fetch in setInterval without timeout', () => {
    const file = makeFile(`export async function GET(req) {
  setInterval(async () => {
    const res = await fetch('https://api.example.com/poll')
  }, 30000)
  return Response.json({ ok: true })
}`, { relativePath: 'app/api/poll/route.ts' })
    const findings = missingAbortControllerRule.check(file, project)
    expect(findings).toHaveLength(1)
  })

  it('allows axios with inline timeout', () => {
    const file = makeFile(`export async function GET(req) {
  const res = await axios.get('https://api.example.com', { timeout: 5000 })
  return Response.json(res.data)
}`, { relativePath: 'app/api/proxy/route.ts' })
    const findings = missingAbortControllerRule.check(file, project)
    expect(findings).toHaveLength(0)
  })
})
