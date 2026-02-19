import type { Rule, Finding, FileContext, ProjectContext } from '../types.js'
import { isApiRoute, isTestFile } from '../utils/patterns.js'

const WEBHOOK_PATH = /webhook/i

const VERIFICATION_PATTERNS = [
  /constructEvent\s*\(/,           // Stripe
  /webhooks\.verify\s*\(/,         // Clerk, GitHub
  /verify\s*\(/,                   // Generic
  /verifySignature\s*\(/,          // Generic
  /validateWebhook\s*\(/,          // Generic
  /svix.*verify/i,                 // Svix (used by Clerk, Resend)
  /crypto\.timingSafeEqual\s*\(/,  // Manual HMAC comparison
  /hmac/i,                         // HMAC verification
  /x-hub-signature/i,              // GitHub webhooks
  /stripe-signature/i,             // Stripe signature header
  /svix-signature/i,               // Svix signature header
  /webhook-secret/i,
]

export const missingWebhookVerificationRule: Rule = {
  id: 'missing-webhook-verification',
  name: 'Missing Webhook Verification',
  description: 'Detects webhook endpoints without signature verification — anyone can send fake events',
  category: 'security',
  severity: 'critical',
  fileExtensions: ['ts', 'tsx', 'js', 'jsx'],

  check(file: FileContext, _project: ProjectContext): Finding[] {
    if (isTestFile(file.relativePath)) return []
    if (!isApiRoute(file.relativePath)) return []
    if (!WEBHOOK_PATH.test(file.relativePath)) return []

    const hasVerification = VERIFICATION_PATTERNS.some(p => p.test(file.content))
    if (hasVerification) return []

    let handlerLine = 1
    for (let i = 0; i < file.lines.length; i++) {
      if (/export\s+(async\s+)?function\s+POST\b/.test(file.lines[i])) {
        handlerLine = i + 1
        break
      }
    }

    return [{
      ruleId: 'missing-webhook-verification',
      file: file.relativePath,
      line: handlerLine,
      column: 1,
      message: 'Webhook endpoint has no signature verification — anyone can forge events to this route',
      severity: 'critical',
      category: 'security',
      fix: 'Verify the webhook signature before processing. For Stripe: stripe.webhooks.constructEvent(body, sig, secret)',
    }]
  },
}
