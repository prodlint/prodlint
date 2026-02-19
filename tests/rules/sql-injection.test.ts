import { describe, it, expect } from 'vitest'
import { sqlInjectionRule } from '../../src/rules/sql-injection.js'
import { makeFile, makeProject } from '../helpers.js'

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
})
