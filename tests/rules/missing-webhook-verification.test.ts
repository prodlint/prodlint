import { describe, it, expect } from 'vitest'
import { missingWebhookVerificationRule } from '../../src/rules/missing-webhook-verification.js'
import { makeFile, makeProject } from '../helpers.js'

const project = makeProject()

describe('missing-webhook-verification rule', () => {
  it('detects webhook route without verification', () => {
    const file = makeFile(`export async function POST(req) {
  const body = await req.json()
  await processEvent(body)
  return Response.json({ ok: true })
}`, { relativePath: 'app/api/webhook/route.ts' })
    const findings = missingWebhookVerificationRule.check(file, project)
    expect(findings).toHaveLength(1)
    expect(findings[0].severity).toBe('critical')
  })

  it('allows webhook with constructEvent (Stripe)', () => {
    const file = makeFile(`export async function POST(req) {
  const event = stripe.webhooks.constructEvent(body, sig, secret)
  await processEvent(event)
}`, { relativePath: 'app/api/webhook/route.ts' })
    const findings = missingWebhookVerificationRule.check(file, project)
    expect(findings).toHaveLength(0)
  })

  it('allows webhook with svix verification', () => {
    const file = makeFile(`export async function POST(req) {
  const svix = new Webhook(secret)
  const event = svix.verify(body, headers)
}`, { relativePath: 'app/api/webhook/route.ts' })
    const findings = missingWebhookVerificationRule.check(file, project)
    expect(findings).toHaveLength(0)
  })

  it('allows webhook with HMAC verification', () => {
    const file = makeFile(`export async function POST(req) {
  const hmac = crypto.createHmac('sha256', secret)
  if (!crypto.timingSafeEqual(expected, actual)) throw new Error()
}`, { relativePath: 'app/api/webhook/route.ts' })
    const findings = missingWebhookVerificationRule.check(file, project)
    expect(findings).toHaveLength(0)
  })

  it('ignores non-webhook routes', () => {
    const file = makeFile(`export async function POST(req) {
  const body = await req.json()
}`, { relativePath: 'app/api/users/route.ts' })
    const findings = missingWebhookVerificationRule.check(file, project)
    expect(findings).toHaveLength(0)
  })

  it('ignores non-API routes', () => {
    const file = makeFile(`export async function POST(req) {}`, { relativePath: 'lib/webhook.ts' })
    const findings = missingWebhookVerificationRule.check(file, project)
    expect(findings).toHaveLength(0)
  })
})
