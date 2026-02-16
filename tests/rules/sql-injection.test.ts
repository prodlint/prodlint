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
})
