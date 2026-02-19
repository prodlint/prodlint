/**
 * Maps of method names that are legitimate per framework.
 * These should NOT be flagged by hallucinated-api.
 */
export const FRAMEWORK_SAFE_METHODS: Record<string, string[]> = {
  prisma: ['contains', 'startsWith', 'endsWith', 'has', 'hasEvery', 'hasSome', 'isEmpty'],
  supabase: ['contains', 'containedBy', 'overlaps', 'eq', 'neq', 'gt', 'gte', 'lt', 'lte'],
  drizzle: ['arrayContains', 'arrayContainedIn', 'arrayOverlaps'],
  lodash: ['flatten', 'flattenDeep', 'contains', 'includes', 'has'],
  mongoose: ['contains'],
}

/**
 * Check if a method name is a known safe method for any detected framework.
 */
export function isFrameworkSafeMethod(methodName: string, frameworks: Set<string>): boolean {
  for (const framework of frameworks) {
    const safeMethods = FRAMEWORK_SAFE_METHODS[framework]
    if (safeMethods && safeMethods.includes(methodName)) {
      return true
    }
  }
  return false
}

/**
 * Map of package names to framework identifiers.
 * Used to populate detectedFrameworks from declaredDependencies.
 */
export const DEPENDENCY_TO_FRAMEWORK: Record<string, string> = {
  '@prisma/client': 'prisma',
  'prisma': 'prisma',
  '@supabase/supabase-js': 'supabase',
  '@supabase/ssr': 'supabase',
  'drizzle-orm': 'drizzle',
  '@trpc/server': 'trpc',
  'next-auth': 'next-auth',
  '@auth/nextjs': 'next-auth',
  '@auth/core': 'next-auth',
  'express': 'express',
  'fastify': 'fastify',
  'hono': 'hono',
  'lodash': 'lodash',
  'lodash-es': 'lodash',
  'underscore': 'lodash',
  'mongoose': 'mongoose',
  'typeorm': 'typeorm',
  'sequelize': 'sequelize',
  'knex': 'knex',
  '@upstash/ratelimit': 'upstash-ratelimit',
  'express-rate-limit': 'express-rate-limit',
  'rate-limiter-flexible': 'rate-limiter-flexible',
}

/**
 * ORM/query-builder frameworks that parameterize by default.
 * SQL findings should be downgraded for these.
 */
export const SQL_SAFE_ORMS = new Set(['prisma', 'drizzle', 'knex', 'typeorm', 'sequelize'])

/**
 * Frameworks that provide centralized rate limiting.
 */
export const RATE_LIMIT_FRAMEWORKS = new Set(['upstash-ratelimit', 'express-rate-limit', 'rate-limiter-flexible'])
