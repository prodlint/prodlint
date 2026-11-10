import { describe, it, expect } from 'vitest'
import { sqlInjectionRule } from '../../src/rules/sql-injection.js'
import { makeFile, makeProject, scanFiles } from '../helpers.js'

const project = makeProject()

describe('sql-injection rule', () => {
  it('flags template literal SQL with interpolation', () => {
    const code = 'const q = `SELECT * FROM users WHERE id = ${userId}`'
    const file = makeFile(code)
    const findings = sqlInjectionRule.check(file, project)
    expect(findings).toHaveLength(1)
    expect(findings[0].message).toContain('template literal')
  })

  it('flags string concat SQL', () => {
    const file = makeFile(`const q = "SELECT * FROM users WHERE id = " + userId`)
    const findings = sqlInjectionRule.check(file, project)
    expect(findings).toHaveLength(1)
    expect(findings[0].message).toContain('concatenation')
  })

  it('flags .query() with template literal', () => {
    const code = 'db.query(`SELECT * FROM users WHERE name = ${name}`)'
    const file = makeFile(code)
    const findings = sqlInjectionRule.check(file, project)
    expect(findings).toHaveLength(1)
  })

  it('flags .execute() with template literal', () => {
    const code = 'conn.execute(`INSERT INTO logs VALUES (${msg})`)'
    const file = makeFile(code)
    const findings = sqlInjectionRule.check(file, project)
    expect(findings).toHaveLength(1)
  })

  it('passes parameterized query', () => {
    const file = makeFile(`db.query("SELECT * FROM users WHERE id = $1", [userId])`)
    const findings = sqlInjectionRule.check(file, project)
    expect(findings).toHaveLength(0)
  })

  it('passes static SQL string', () => {
    const file = makeFile(`const q = "SELECT * FROM users"`)
    const findings = sqlInjectionRule.check(file, project)
    expect(findings).toHaveLength(0)
  })

  it('skips comments', () => {
    const code = '// const q = `SELECT * FROM users WHERE id = ${userId}`'
    const file = makeFile(code)
    const findings = sqlInjectionRule.check(file, project)
    expect(findings).toHaveLength(0)
  })

  it('skips block comments', () => {
    const code = '/*\n`SELECT * FROM users WHERE id = ${userId}`\n*/'
    const file = makeFile(code)
    const findings = sqlInjectionRule.check(file, project)
    expect(findings).toHaveLength(0)
  })

  it('only reports one finding per line', () => {
    const code = 'db.query(`SELECT * FROM users WHERE id = ${id} AND name = ${name}`)'
    const file = makeFile(code)
    const findings = sqlInjectionRule.check(file, project)
    expect(findings).toHaveLength(1)
  })

  // Tagged template / ORM awareness tests
  it('passes sql tagged template literal', () => {
    const code = 'const result = await sql`SELECT * FROM users WHERE id = ${userId}`'
    const file = makeFile(code)
    const findings = sqlInjectionRule.check(file, project)
    expect(findings).toHaveLength(0)
  })

  it('passes Prisma.sql tagged template', () => {
    const code = 'const result = await Prisma.sql`SELECT * FROM users WHERE id = ${userId}`'
    const file = makeFile(code)
    const findings = sqlInjectionRule.check(file, project)
    expect(findings).toHaveLength(0)
  })

  it('downgrades to warning when Prisma ORM is detected', () => {
    const prismaProject = makeProject({ detectedFrameworks: new Set(['prisma']) })
    const code = 'db.query(`SELECT * FROM users WHERE name = ${name}`)'
    const file = makeFile(code)
    const findings = sqlInjectionRule.check(file, prismaProject)
    expect(findings).toHaveLength(1)
    expect(findings[0].severity).toBe('warning')
  })

  it('stays critical without ORM context', () => {
    const code = 'db.query(`SELECT * FROM users WHERE name = ${name}`)'
    const file = makeFile(code)
    const findings = sqlInjectionRule.check(file, project)
    expect(findings).toHaveLength(1)
    expect(findings[0].severity).toBe('critical')
  })

  // AST-specific tagged template detection
  it('skips sql tagged template via AST detection (ast populated)', () => {
    const code = 'const result = sql`SELECT * FROM users WHERE id = ${userId}`'
    const file = makeFile(code) // ast populated by default
    expect(file.ast).not.toBeNull()
    const findings = sqlInjectionRule.check(file, project)
    expect(findings).toHaveLength(0)
  })

  it('skips db.raw tagged template via AST', () => {
    const code = 'const result = db.raw`SELECT * FROM users WHERE id = ${userId}`'
    const file = makeFile(code)
    const findings = sqlInjectionRule.check(file, project)
    expect(findings).toHaveLength(0)
  })

  // Regex fallback when AST is absent
  it('skips sql tagged template via regex fallback (no ast)', () => {
    const code = 'const result = sql`SELECT * FROM users WHERE id = ${userId}`'
    const file = makeFile(code, { withAst: false })
    expect(file.ast).toBeUndefined()
    const findings = sqlInjectionRule.check(file, project)
    expect(findings).toHaveLength(0)
  })

  it('still flags raw template literal even with AST (not tagged)', () => {
    const code = 'const q = `SELECT * FROM users WHERE id = ${userId}`'
    const file = makeFile(code)
    expect(file.ast).not.toBeNull()
    const findings = sqlInjectionRule.check(file, project)
    expect(findings).toHaveLength(1)
  })

  // Drizzle ORM downgrade
  it('downgrades to warning when Drizzle ORM is detected', () => {
    const drizzleProject = makeProject({ detectedFrameworks: new Set(['drizzle']) })
    const code = 'db.execute(`INSERT INTO users VALUES (${name})`)'
    const file = makeFile(code)
    const findings = sqlInjectionRule.check(file, drizzleProject)
    expect(findings).toHaveLength(1)
    expect(findings[0].severity).toBe('warning')
  })

  it("reads the ORM of the file's own package", () => {
    const scoped = makeProject({
      packageScopes: new Map([
        ['', { frameworks: new Set<string>(), hasRateLimiting: false }],
        ['examples/demo', { frameworks: new Set(['prisma']), hasRateLimiting: false }],
      ]),
    })
    const code = 'db.query(`SELECT * FROM users WHERE name = ${name}`)'
    const severity = (relativePath: string) => sqlInjectionRule.check(makeFile(code, { relativePath }), scoped)[0].severity

    expect(severity('src/users.ts')).toBe('critical')
    expect(severity('examples/demo/users.ts')).toBe('warning')
  })
})

// Through the scanner. Every package.json in the tree used to count for every file, so an
// example app or a test fixture that listed an ORM lowered this rule for the whole project
describe('sql-injection — an ORM in another package.json of the tree', () => {
  const QUERY = "export const findUser = (db, name) => db.query(`SELECT * FROM users WHERE name = '${name}'`)\n"
  const pkg = (name: string, dependencies: Record<string, string> = {}, more: object = {}) =>
    JSON.stringify({ name, dependencies, ...more })
  const severities = async (files: Record<string, string>) => Object.fromEntries(
    (await scanFiles(files)).findings.filter(f => f.ruleId === 'sql-injection').map(f => [f.file, f.severity]),
  )

  it('stays critical next to an example app that lists Prisma', async () => {
    const app = { 'package.json': pkg('app', { pg: '^8.11.0' }), 'src/users.ts': QUERY }
    expect(await severities(app)).toEqual({ 'src/users.ts': 'critical' })

    expect(await severities({
      ...app,
      'examples/demo/package.json': pkg('demo', { '@prisma/client': '^6.0.0' }),
      'examples/demo/report.ts': QUERY,
    })).toEqual({ 'src/users.ts': 'critical', 'examples/demo/report.ts': 'warning' })
  })

  it('is still lowered across a declared workspace', async () => {
    expect(await severities({
      'package.json': pkg('acme', {}, { private: true, workspaces: ['apps/*', 'packages/*'] }),
      'packages/db/package.json': pkg('@acme/db', { 'drizzle-orm': '^0.44.0' }),
      'apps/web/package.json': pkg('web', { '@acme/db': 'workspace:*' }),
      'apps/web/lib/users.ts': QUERY,
      'tests/fixtures/shop/package.json': pkg('shop', { knex: '^3.0.0' }),
    })).toEqual({ 'apps/web/lib/users.ts': 'warning' })
  })

  // No workspace is declared here: a `file:` link, or a scan that starts below the workspace root
  it('is lowered for a package that depends on the one with the ORM', async () => {
    const repo = {
      'db/package.json': pkg('@acme/db', { '@prisma/client': '^6.0.0' }),
      'db/index.ts': "export { PrismaClient } from '@prisma/client'\n",
      'docs/package.json': pkg('docs'),
      'docs/search.ts': QUERY,
      'web/lib/users.ts': QUERY,
    }
    const lowered = { 'docs/search.ts': 'critical', 'web/lib/users.ts': 'warning' }

    // In its package.json
    expect(await severities({ ...repo, 'web/package.json': pkg('web', { '@acme/db': 'file:../db' }) })).toEqual(lowered)

    // Or in an import alone, which a hoisted workspace allows, by the package's scoped name
    expect(await severities({
      ...repo,
      'web/package.json': pkg('web'),
      'web/lib/db.ts': "import { PrismaClient } from '@acme/db'\n\nexport const db = new PrismaClient()\n",
    })).toEqual(lowered)

    expect(await severities({ ...repo, 'web/package.json': pkg('web') }))
      .toEqual({ 'docs/search.ts': 'critical', 'web/lib/users.ts': 'critical' })
  })
})
