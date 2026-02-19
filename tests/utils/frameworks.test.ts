import { describe, it, expect } from 'vitest'
import { isFrameworkSafeMethod, DEPENDENCY_TO_FRAMEWORK, SQL_SAFE_ORMS, RATE_LIMIT_FRAMEWORKS } from '../../src/utils/frameworks.js'

describe('isFrameworkSafeMethod', () => {
  it('returns true for .contains() with Prisma', () => {
    expect(isFrameworkSafeMethod('contains', new Set(['prisma']))).toBe(true)
  })

  it('returns true for .contains() with Supabase', () => {
    expect(isFrameworkSafeMethod('contains', new Set(['supabase']))).toBe(true)
  })

  it('returns true for .flatten() with lodash', () => {
    expect(isFrameworkSafeMethod('flatten', new Set(['lodash']))).toBe(true)
  })

  it('returns true for .startsWith() with Prisma', () => {
    expect(isFrameworkSafeMethod('startsWith', new Set(['prisma']))).toBe(true)
  })

  it('returns false for .substr() with Prisma', () => {
    expect(isFrameworkSafeMethod('substr', new Set(['prisma']))).toBe(false)
  })

  it('returns false for unknown framework', () => {
    expect(isFrameworkSafeMethod('contains', new Set(['unknown']))).toBe(false)
  })

  it('returns false with no frameworks', () => {
    expect(isFrameworkSafeMethod('contains', new Set())).toBe(false)
  })

  it('checks multiple frameworks', () => {
    expect(isFrameworkSafeMethod('flatten', new Set(['prisma', 'lodash']))).toBe(true)
  })
})

describe('DEPENDENCY_TO_FRAMEWORK', () => {
  it('maps @prisma/client to prisma', () => {
    expect(DEPENDENCY_TO_FRAMEWORK['@prisma/client']).toBe('prisma')
  })

  it('maps @supabase/supabase-js to supabase', () => {
    expect(DEPENDENCY_TO_FRAMEWORK['@supabase/supabase-js']).toBe('supabase')
  })

  it('maps drizzle-orm to drizzle', () => {
    expect(DEPENDENCY_TO_FRAMEWORK['drizzle-orm']).toBe('drizzle')
  })

  it('maps lodash-es to lodash', () => {
    expect(DEPENDENCY_TO_FRAMEWORK['lodash-es']).toBe('lodash')
  })

  it('maps @upstash/ratelimit', () => {
    expect(DEPENDENCY_TO_FRAMEWORK['@upstash/ratelimit']).toBe('upstash-ratelimit')
  })
})

describe('SQL_SAFE_ORMS', () => {
  it('includes prisma', () => {
    expect(SQL_SAFE_ORMS.has('prisma')).toBe(true)
  })

  it('includes drizzle', () => {
    expect(SQL_SAFE_ORMS.has('drizzle')).toBe(true)
  })

  it('does not include express', () => {
    expect(SQL_SAFE_ORMS.has('express')).toBe(false)
  })
})

describe('RATE_LIMIT_FRAMEWORKS', () => {
  it('includes upstash-ratelimit', () => {
    expect(RATE_LIMIT_FRAMEWORKS.has('upstash-ratelimit')).toBe(true)
  })

  it('includes express-rate-limit', () => {
    expect(RATE_LIMIT_FRAMEWORKS.has('express-rate-limit')).toBe(true)
  })
})
