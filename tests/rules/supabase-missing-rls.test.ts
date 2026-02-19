import { describe, it, expect } from 'vitest'
import { supabaseMissingRlsRule } from '../../src/rules/supabase-missing-rls.js'
import { makeFile, makeProject } from '../helpers.js'

const project = makeProject()

describe('supabase-missing-rls rule', () => {
  it('detects CREATE TABLE without RLS', () => {
    const file = makeFile(`
CREATE TABLE users (
  id uuid PRIMARY KEY,
  email text NOT NULL
);
`, { relativePath: 'supabase/migrations/001_init.sql', ext: 'sql' })
    const findings = supabaseMissingRlsRule.check(file, project)
    expect(findings).toHaveLength(1)
    expect(findings[0].severity).toBe('critical')
    expect(findings[0].message).toContain('users')
  })

  it('allows CREATE TABLE with RLS enabled', () => {
    const file = makeFile(`
CREATE TABLE users (
  id uuid PRIMARY KEY,
  email text NOT NULL
);
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
`, { relativePath: 'supabase/migrations/001_init.sql', ext: 'sql' })
    const findings = supabaseMissingRlsRule.check(file, project)
    expect(findings).toHaveLength(0)
  })

  it('detects multiple tables, flags only missing ones', () => {
    const file = makeFile(`
CREATE TABLE users (id uuid PRIMARY KEY);
CREATE TABLE posts (id uuid PRIMARY KEY);
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
`, { relativePath: 'supabase/migrations/002_posts.sql', ext: 'sql' })
    const findings = supabaseMissingRlsRule.check(file, project)
    expect(findings).toHaveLength(1)
    expect(findings[0].message).toContain('posts')
  })

  it('ignores non-migration files', () => {
    const file = makeFile(`CREATE TABLE test (id int);`, { relativePath: 'src/lib/query.sql', ext: 'sql' })
    const findings = supabaseMissingRlsRule.check(file, project)
    expect(findings).toHaveLength(0)
  })

  it('handles IF NOT EXISTS', () => {
    const file = makeFile(`
CREATE TABLE IF NOT EXISTS profiles (id uuid PRIMARY KEY);
`, { relativePath: 'supabase/migrations/003_profiles.sql', ext: 'sql' })
    const findings = supabaseMissingRlsRule.check(file, project)
    expect(findings).toHaveLength(1)
    expect(findings[0].message).toContain('profiles')
  })

  it('handles public schema prefix', () => {
    const file = makeFile(`
CREATE TABLE public.orders (id uuid PRIMARY KEY);
ALTER TABLE public.orders ENABLE ROW LEVEL SECURITY;
`, { relativePath: 'supabase/migrations/004_orders.sql', ext: 'sql' })
    const findings = supabaseMissingRlsRule.check(file, project)
    expect(findings).toHaveLength(0)
  })
})
