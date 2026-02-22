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
  severity: 'info',
  fileExtensions: ['ts', 'tsx', 'js', 'jsx'],

  check(file: FileContext, project: ProjectContext): Finding[] {
    if (!isApiRoute(file.relativePath)) return []

    // If project has centralized rate limiting, skip all per-route checks
    if (project.hasRateLimiting) return []

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
      message: 'No rate limiting — anyone could spam this endpoint and run up your API costs',
      severity: 'info',
      category: 'security',
      fix: "Add rate limiting: import { Ratelimit } from '@upstash/ratelimit' or use express-rate-limit",
    }]
  },
}
