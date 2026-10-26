import { describe, it, expect } from 'vitest'
import { supabaseMissingRlsRule } from '../../src/rules/supabase-missing-rls.js'
import type { FileContext } from '../../src/types.js'
import { makeFile, makeProject, scanFiles } from '../helpers.js'

const project = makeProject()

/** Both scan phases, so the tests hold whichever one the rule reports from */
function check(...files: FileContext[]) {
  return [
    ...files.flatMap(file => supabaseMissingRlsRule.check(file, project)),
    ...(supabaseMissingRlsRule.checkProject?.(files, project) ?? []),
  ]
}

function sql(relativePath: string, content: string) {
  return makeFile(content, { relativePath, ext: 'sql' })
}

describe('supabase-missing-rls rule', () => {
  it('detects CREATE TABLE without RLS', () => {
    const findings = check(sql('supabase/migrations/001_init.sql', `
CREATE TABLE users (
  id uuid PRIMARY KEY,
  email text NOT NULL
);
`))
    expect(findings).toHaveLength(1)
    expect(findings[0].severity).toBe('critical')
    expect(findings[0].message).toContain('users')
  })

  it('allows CREATE TABLE with RLS enabled', () => {
    const findings = check(sql('supabase/migrations/001_init.sql', `
CREATE TABLE users (
  id uuid PRIMARY KEY,
  email text NOT NULL
);
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
`))
    expect(findings).toHaveLength(0)
  })

  it('detects multiple tables, flags only missing ones', () => {
    const findings = check(sql('supabase/migrations/002_posts.sql', `
CREATE TABLE users (id uuid PRIMARY KEY);
CREATE TABLE posts (id uuid PRIMARY KEY);
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
`))
    expect(findings).toHaveLength(1)
    expect(findings[0].message).toContain('posts')
  })

  it('ignores non-migration files', () => {
    const findings = check(sql('src/lib/query.sql', `CREATE TABLE test (id int);`))
    expect(findings).toHaveLength(0)
  })

  it('handles IF NOT EXISTS', () => {
    const findings = check(sql('supabase/migrations/003_profiles.sql', `
CREATE TABLE IF NOT EXISTS profiles (id uuid PRIMARY KEY);
`))
    expect(findings).toHaveLength(1)
    expect(findings[0].message).toContain('profiles')
  })

  it('handles public schema prefix', () => {
    const findings = check(sql('supabase/migrations/004_orders.sql', `
CREATE TABLE public.orders (id uuid PRIMARY KEY);
ALTER TABLE public.orders ENABLE ROW LEVEL SECURITY;
`))
    expect(findings).toHaveLength(0)
  })

  // Through the scanner: the per-file check never saw the other migrations
  it('accepts RLS enabled in a later migration', async () => {
    const result = await scanFiles({
      'supabase/migrations/001_init.sql': 'CREATE TABLE profiles (id uuid PRIMARY KEY);\nCREATE TABLE posts (id uuid PRIMARY KEY);\n',
      'supabase/migrations/002_rls.sql': 'ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;\n',
    })
    const findings = result.findings.filter(f => f.ruleId === 'supabase-missing-rls')
    expect(findings.map(f => `${f.file}:${f.line}`)).toEqual(['supabase/migrations/001_init.sql:2'])
    expect(findings[0].message).toContain('"posts"')
  })

  it("doesn't let another project in the repo vouch for a table", () => {
    const findings = check(
      sql('examples/caching/supabase/migrations/001_init.sql', 'CREATE TABLE countries (id int);'),
      sql('examples/realtime/supabase/migrations/001_init.sql', 'CREATE TABLE countries (id int);\nALTER TABLE countries ENABLE ROW LEVEL SECURITY;'),
      sql('db/migrations/001_init.sql', 'CREATE TABLE notes (id int);'),
      sql('db/policies.sql', 'ALTER TABLE notes ENABLE ROW LEVEL SECURITY;'),
    )
    expect(findings.map(f => f.file)).toEqual(['examples/caching/supabase/migrations/001_init.sql'])
  })

  it('reads quoted and IF EXISTS forms of ENABLE ROW LEVEL SECURITY', () => {
    const findings = check(
      sql('supabase/migrations/001_init.sql', 'CREATE TABLE public.profiles (id uuid);\nCREATE TABLE notes (id uuid);\nCREATE TABLE tags (id uuid);'),
      sql('supabase/migrations/002_rls.sql', [
        'ALTER TABLE "public"."profiles" ENABLE ROW LEVEL SECURITY;',
        'ALTER TABLE IF EXISTS ONLY notes ENABLE ROW LEVEL SECURITY;',
        'alter table "tags" enable row level security;',
      ].join('\n')),
    )
    expect(findings).toHaveLength(0)
  })

  it('still honors prodlint-disable-next-line in the migration', async () => {
    const result = await scanFiles({
      'supabase/migrations/001_init.sql': '-- prodlint-disable-next-line supabase-missing-rls\nCREATE TABLE audit_log (id uuid PRIMARY KEY);\n',
    })
    expect(result.findings.filter(f => f.ruleId === 'supabase-missing-rls')).toHaveLength(0)
  })
})
