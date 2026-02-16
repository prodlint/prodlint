import type { Rule, Finding, FileContext, ProjectContext } from '../types.js'
import { isApiRoute } from '../utils/patterns.js'

// Patterns indicating rate limiting is present
const RATE_LIMIT_PATTERNS = [
  /rateLimit/i,
  /rateLimiter/i,
  /rate-limit/i,
  /upstash.*ratelimit/i,
  /Ratelimit/,
  /@upstash\/ratelimit/,
  /express-rate-limit/,
  /limiter/i,
  /throttle/i,
  /slidingWindow/,
  /fixedWindow/,
  /tokenBucket/,
]

// Routes that typically don't need rate limiting
const EXEMPT_PATTERNS = [
  /health/i,
  /ping/i,
  /webhook/i,
  /cron/i,
  /inngest/i,
]

export const rateLimitingRule: Rule = {
  id: 'rate-limiting',
  name: 'Missing Rate Limiting',
  description: 'Detects API routes without rate limiting',
  category: 'security',
  severity: 'warning',
  fileExtensions: ['ts', 'tsx', 'js', 'jsx'],

  check(file: FileContext, _project: ProjectContext): Finding[] {
    if (!isApiRoute(file.relativePath)) return []

    // Check if route is exempt
    for (const pattern of EXEMPT_PATTERNS) {
      if (pattern.test(file.relativePath)) return []
    }

    // Check if rate limiting exists in the file
    for (const pattern of RATE_LIMIT_PATTERNS) {
      if (pattern.test(file.content)) return []
    }

    // Find the handler line
    let handlerLine = 1
    for (let i = 0; i < file.lines.length; i++) {
      if (/export\s+(async\s+)?function\s+(GET|POST|PUT|PATCH|DELETE|handler)/i.test(file.lines[i])) {
        handlerLine = i + 1
        break
      }
    }

    return [{
      ruleId: 'rate-limiting',
      file: file.relativePath,
      line: handlerLine,
      column: 1,
      message: 'API route has no rate limiting',
      severity: 'warning',
      category: 'security',
    }]
  },
}
