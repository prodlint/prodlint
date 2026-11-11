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

  // Prisma's raw queries. $queryRaw`...` and $executeRaw`...` send what they interpolate as
  // parameters; $queryRawUnsafe() and $executeRawUnsafe() run the string they're given.
  describe('Prisma raw queries', () => {
    const prismaProject = makeProject({ detectedFrameworks: new Set(['prisma']) })

    // Each case is read from the syntax tree and, as for a file Babel can't parse, from the text
    describe.each([
      ['with the AST', true],
      ['with the regex fallback', false],
    ])('%s', (_name, withAst) => {
      const check = (code: string, p = project) => sqlInjectionRule.check(makeFile(code, { withAst }), p)
      /** "line severity" of each finding, with and without Prisma in package.json: it has to be the same */
      const found = (code: string) => {
        const listed = check(code, prismaProject).map(f => `${f.line} ${f.severity}`)
        expect(check(code).map(f => `${f.line} ${f.severity}`)).toEqual(listed)
        return listed
      }

      it('reads the tree, or the text', () => {
        const file = makeFile('const rows = await prisma.$queryRaw`SELECT 1`', { withAst })
        expect(Boolean(file.ast)).toBe(withAst)
      })

      it.each(['prisma', 'tx', 'db', 'ctx.prisma', 'this.prisma'])('passes $queryRaw as a tag on %s', (receiver) => {
        expect(found('const rows = await ' + receiver + '.$queryRaw`SELECT * FROM users WHERE id = ${id}`')).toEqual([])
      })

      it('passes $executeRaw as a tag', () => {
        expect(found('await tx.$executeRaw`UPDATE users SET name = ${name} WHERE id = ${id}`')).toEqual([])
      })

      it('passes a tag with a type argument', () => {
        expect(found('const rows = await prisma.$queryRaw<User[]>`SELECT * FROM users WHERE id = ${id}`')).toEqual([])
      })

      it('passes a tag whose template starts on the next line', () => {
        const code = [
          'const rows = await prisma.$queryRaw<User[]>',
          '  `SELECT * FROM users WHERE id = ${id}`',
        ].join('\n')
        expect(found(code)).toEqual([])
      })

      it('passes a tag whose type argument is spread over lines', () => {
        const code = [
          'const result = await tx.$queryRaw<',
          '  Array<{ usage: number; limits: Record<string, Array<number>>; onChange: () => void }>',
          '>`SELECT usage, limits FROM projects WHERE id = ${workspace.id} FOR UPDATE`',
        ].join('\n')
        expect(found(code)).toEqual([])
      })

      it('passes every line of a tagged template', () => {
        // On its own, the UPDATE line reads as a concatenation
        const code = [
          'await prisma.$executeRaw`',
          '  UPDATE posts SET views = views + 1',
          '  WHERE id = ${id}',
          '`',
        ].join('\n')
        expect(found(code)).toEqual([])
      })

      it('passes Prisma.join, Prisma.sql and Prisma.empty in a tagged template', () => {
        const code = [
          'const rows = await prisma.$queryRaw<User[]>`SELECT * FROM users WHERE id IN (${Prisma.join(ids)})',
          '  ${name ? Prisma.sql`AND name = ${name}` : Prisma.empty}`',
        ].join('\n')
        expect(found(code)).toEqual([])
      })

      it('passes $queryRaw() given Prisma.sql', () => {
        expect(found('const rows = await prisma.$queryRaw(Prisma.sql`SELECT * FROM users WHERE id = ${id}`)')).toEqual([])
      })

      it('does not take $queryRawUnsafe for a tag', () => {
        // As a tag it gets the template's strings as an array, not a query: left to the patterns
        const code = 'const rows = await prisma.$queryRawUnsafe`SELECT * FROM users WHERE id = ${id}`'
        expect(check(code, prismaProject).map(f => `${f.line} ${f.severity}`)).toEqual(['1 warning'])
      })

      it('passes Prisma.sql over several lines', () => {
        const code = [
          'const where = Prisma.sql`s.store = ${storeId}',
          "  AND (${search} = '' OR EXISTS (SELECT 1 FROM items i WHERE i.name ILIKE ${'%' + search + '%'}))`",
        ].join('\n')
        expect(found(code)).toEqual([])
      })

      it('flags $queryRawUnsafe() with template literal interpolation', () => {
        const findings = check("const rows = await prisma.$queryRawUnsafe(`SELECT * FROM users WHERE email = '${email}'`)")
        expect(findings).toHaveLength(1)
        expect(findings[0]).toMatchObject({ line: 1, severity: 'critical' })
        expect(findings[0].message).toBe('$queryRawUnsafe() query built with template literal interpolation — use the $queryRaw tagged template or pass values as parameters')
        expect(findings[0].fix).toContain('prisma.$queryRaw`')
      })

      it('flags $executeRawUnsafe() with string concatenation', () => {
        const findings = check("await tx.$executeRawUnsafe('DELETE FROM users WHERE id = ' + id)")
        expect(findings).toHaveLength(1)
        expect(findings[0]).toMatchObject({ line: 1, severity: 'critical' })
        expect(findings[0].message).toContain('$executeRawUnsafe() query built with string concatenation')
        expect(findings[0].fix).toContain('prisma.$executeRaw`')
      })

      it('does not lower it in a Prisma project, as it does a string it only sees built', () => {
        const code = [
          'const rows = await prisma.$queryRawUnsafe(`SELECT * FROM users WHERE id = ${id}`)',
          'const text = `SELECT * FROM users WHERE id = ${id}`',
        ].join('\n')
        expect(check(code, prismaProject).map(f => `${f.line} ${f.severity}`)).toEqual(['1 critical', '2 warning'])
        expect(check(code).map(f => `${f.line} ${f.severity}`)).toEqual(['1 critical', '2 critical'])
      })

      it('flags a query that spans lines once, where it starts', () => {
        // On its own, the UPDATE line reads as a concatenation
        const code = [
          'await prisma.$executeRawUnsafe(`',
          '  UPDATE users SET credits = credits + 1',
          "  WHERE email = '${email}'",
          '`)',
        ].join('\n')
        expect(found(code)).toEqual(['1 critical'])
      })

      it('flags a query on the line its string starts, not the call', () => {
        const code = [
          'const rows = await prisma.$queryRawUnsafe(',
          '  `SELECT * FROM users WHERE id = ${id}`,',
          ')',
        ].join('\n')
        // The comma a formatter leaves before the `)` passes no value
        expect(found(code)).toEqual(['2 critical'])
        // A string that starts its line
        expect(found('await prisma.$executeRawUnsafe(\n`DELETE FROM users WHERE id = ${id}`)')).toEqual(['2 critical'])
      })

      it.each([
        "const rows = await prisma.$queryRawUnsafe(`select * from users where email = '${email}'`)",
        'const rows = await prisma.$queryRawUnsafe(`WITH recent AS (SELECT * FROM orders WHERE user_id = ${userId}) SELECT * FROM recent`)',
        "const rows = await prisma.$queryRawUnsafe(`EXEC sp_get_slots @court_id = ${courtId}, @date = '${date}'`)",
        'await prisma.$executeRawUnsafe(`  -- one row\n  DELETE FROM users WHERE id = ${id}`)',
        'await ctx.prisma?.$executeRawUnsafe?.(`DELETE FROM users WHERE id = ${id}`)',
        'const rows = await prisma.$queryRawUnsafe<User[]>(`SELECT * FROM users WHERE id = ${id}`)',
      ])('flags a statement that takes values and passes none as critical: %s', (code) => {
        expect(found(code)).toEqual(['1 critical'])
      })

      it.each([
        'await prisma.$executeRawUnsafe(`TRUNCATE TABLE "${table}" CASCADE`)',
        "await prisma.$executeRawUnsafe(`SET LOCAL app.tenant = '${tenantId}'`)",
        'await tx.$executeRawUnsafe(`SAVEPOINT ${name}`)',
        'await prisma.$executeRawUnsafe(`TRUNCATE TABLE \\`${table}\\`;`)',
        'await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)',
        'const rows = await prisma.$queryRawUnsafe(`${baseQuery} LIMIT ${limit}`)',
        "await prisma.$executeRawUnsafe(prefix + ' WHERE id = ' + id)",
      ])('flags any other built query as a warning: %s', (code) => {
        expect(found(code)).toEqual(['1 warning'])
      })

      it.each([
        'const rows = await prisma.$queryRawUnsafe(`SELECT * FROM "${table}" WHERE id = $1`, id)',
        'const rows = await prisma.$queryRawUnsafe(`SELECT * FROM users WHERE ${where}`, ...params)',
        "await prisma.$executeRawUnsafe('UPDATE ' + table + ' SET name = $1 WHERE id = $2', name, id)",
      ])('flags a query that passes its values as a warning: %s', (code) => {
        expect(found(code)).toEqual(['1 warning'])
      })

      it('passes a constant query', () => {
        expect(found("const rows = await prisma.$queryRawUnsafe('SELECT * FROM users WHERE id = $1', id)")).toEqual([])
        expect(found("const rows = await prisma.$queryRawUnsafe('SELECT * FROM users ' + 'WHERE id = $1', id)")).toEqual([])
        expect(found('await prisma.$executeRawUnsafe(`DELETE FROM sessions`)')).toEqual([])
      })

      it('flags a concatenation with a template that interpolates', () => {
        expect(found("await prisma.$executeRawUnsafe('DELETE FROM users ' + `WHERE id = ${id}`)")).toEqual(['1 critical'])
      })

      it('reads a method taken off its client', () => {
        expect(found('const rows = await $queryRaw`SELECT * FROM users WHERE id = ${id}`')).toEqual([])
        expect(found('const rows = await $queryRawUnsafe(`SELECT * FROM users WHERE id = ${id}`)')).toEqual(['1 critical'])
      })

      it('reports the critical one of two queries that start on a line', () => {
        const select = 'prisma.$queryRawUnsafe(`SELECT * FROM users WHERE id = ${id}`)'
        const truncate = 'prisma.$executeRawUnsafe(`TRUNCATE TABLE "${table}"`)'
        expect(found(`await Promise.all([${select}, ${truncate}])`)).toEqual(['1 critical'])
        expect(found(`await Promise.all([${truncate}, ${select}])`)).toEqual(['1 critical'])
        expect(check(`await Promise.all([${truncate}, ${truncate}])`)).toHaveLength(1)
      })

      it('leaves Prisma.sql() called as a function to the patterns', () => {
        const code = 'const query = Prisma.sql(`SELECT * FROM users WHERE id = ${id}`)'
        expect(check(code, prismaProject).map(f => `${f.line} ${f.severity}`)).toEqual(['1 warning'])
      })

      it('follows a name to the query it holds, given a syntax tree to read its scope from', () => {
        const code = [
          'const query = `SELECT * FROM users WHERE id = ${id}`',
          'const rows = await prisma.$queryRawUnsafe(query)',
        ].join('\n')
        // Without one the string stays with the patterns, and the ORM downgrade
        expect(check(code, prismaProject).map(f => `${f.line} ${f.severity}`)).toEqual([withAst ? '1 critical' : '1 warning'])
      })

      // Prisma 3 and later throw on a string, Prisma 2 ran it: wrong either way, an injection on neither now
      it('flags $queryRaw() called with a plain template, as a warning', () => {
        const findings = check('const rows = await prisma.$queryRaw(`SELECT * FROM users WHERE id = ${id}`)')
        expect(findings).toHaveLength(1)
        expect(findings[0]).toMatchObject({ line: 1, severity: 'warning' })
        expect(findings[0].message).toBe('$queryRaw() called with a string built with template literal interpolation — it takes a tagged template: Prisma 3 and later throw on a string, Prisma 2 runs it as written')
        expect(findings[0].fix).toContain('prisma.$queryRaw`')
        expect(found('const rows = await prisma.$queryRaw(`SELECT * FROM users WHERE id = ${id}`)')).toEqual(['1 warning'])
      })

      it('flags $executeRaw() called with a concatenation, as a warning', () => {
        const findings = check("await prisma.$executeRaw('DELETE FROM users WHERE id = ' + id)")
        expect(findings).toHaveLength(1)
        expect(findings[0].severity).toBe('warning')
        expect(findings[0].message).toContain('$executeRaw() called with a string built with string concatenation')
        expect(found("await prisma.$executeRaw('DELETE FROM users WHERE id = ' + id)")).toEqual(['1 warning'])
      })

      it('flags Prisma.raw() given a built string, in a tagged template too', () => {
        const code = [
          'const rows = await prisma.$queryRaw`',
          '  SELECT * FROM users WHERE team = ${teamId}',
          '  ORDER BY ${Prisma.raw(`"${column}" ${direction}`)}',
          '`',
        ].join('\n')
        expect(found(code)).toEqual(['3 warning'])
        expect(check(code)[0].message).toContain('Prisma.raw() string built with template literal interpolation')
        expect(found('const order = Prisma.sql`ORDER BY ${Prisma.raw(\'"\' + column + \'" DESC\')}`')).toEqual(['1 warning'])
      })

      it('flags Prisma.raw() that holds a whole query as critical', () => {
        const code = [
          'const query = Prisma.raw(`SELECT id, name FROM "User" WHERE name = ${input}`)',
          'const result = await prisma.$queryRaw(query)',
        ].join('\n')
        expect(found(code)).toEqual(['1 critical'])
      })

      it('passes Prisma.raw() given a name or a literal', () => {
        expect(found('const rows = await prisma.$queryRaw`SELECT * FROM users ORDER BY ${Prisma.raw(sortOrder)}`')).toEqual([])
        expect(found('const rows = await prisma.$queryRaw`SELECT * FROM users ORDER BY ${Prisma.raw(\'"createdAt" DESC\')}`')).toEqual([])
      })

      it('does not take a column for a statement', () => {
        // Each starts like a statement, and isn't one
        expect(found('const order = Prisma.raw(`deleted_at ${direction}`)')).toEqual(['1 warning'])
        expect(found('const order = Prisma.raw(`update_time ${direction}`)')).toEqual(['1 warning'])
      })

      it('reads past comments to the statement, in linear time', () => {
        const dashes = '-- ' + '-'.repeat(200)
        const blocks = '/**/ '.repeat(200)
        const started = performance.now()
        expect(found('await prisma.$executeRawUnsafe(`' + dashes + '\nTRUNCATE TABLE "${table}"`)')).toEqual(['1 warning'])
        expect(found('await prisma.$executeRawUnsafe(`' + blocks + 'TRUNCATE TABLE "${table}"`)')).toEqual(['1 warning'])
        expect(found('await prisma.$executeRawUnsafe(`' + dashes + '\n/* one */ (DELETE FROM users WHERE id = ${id})`)')).toEqual(['1 critical'])
        expect(found('await prisma.$executeRawUnsafe(`-- only a comment ${id}`)')).toEqual(['1 warning'])
        expect(performance.now() - started).toBeLessThan(1000)
      })

      it('leaves other raw calls as they were', () => {
        const code = 'const rows = await knex.raw(`SELECT * FROM users WHERE id = ${id}`)'
        expect(check(code).map(f => f.severity)).toEqual(['critical'])
        expect(check(code, makeProject({ detectedFrameworks: new Set(['knex']) })).map(f => f.severity)).toEqual(['warning'])
      })
    })

    describe('what only the AST shows', () => {
      const found = (code: string) => sqlInjectionRule.check(makeFile(code), prismaProject).map(f => `${f.line} ${f.severity}`)

      it('reads both branches of a conditional argument', () => {
        const code = [
          'const rows = await prisma.$queryRawUnsafe(',
          '  all',
          '    ? `SELECT * FROM videos WHERE id < ${lastSeenId}`',
          "    : `SELECT * FROM videos WHERE kind = '${kind}'`",
          ')',
        ].join('\n')
        expect(found(code)).toEqual(['3 critical', '4 critical'])
      })

      it('reads an argument through a cast and parentheses', () => {
        expect(found('const rows = await prisma.$queryRawUnsafe((`SELECT * FROM users WHERE id = ${id}`) as string)')).toEqual(['1 critical'])
      })

      it('reads an interpolation that holds a regex literal', () => {
        const code = [
          'await prisma.$executeRawUnsafe(',
          '  `UPDATE jobs',
          "   SET status = '${status.replace(/'/g, \"''\")}'",
          '   WHERE id = ${Number(id)}`',
          ')',
        ].join('\n')
        expect(found(code)).toEqual(['2 critical'])
      })

      it('passes a constant query with a + in its SQL', () => {
        expect(found("await prisma.$executeRawUnsafe('UPDATE posts SET views = views + 1 WHERE id = $1', id)")).toEqual([])
        expect(found("const rows = await prisma.$queryRawUnsafe('SELECT * FROM users LIMIT ' + 10)")).toEqual([])
      })

      it('does not skip a line for what its strings say', () => {
        // sql` in a string isn't a tag: only the fallback goes by a line's text
        expect(found('const hint = "sql`"; const text = `SELECT * FROM users WHERE id = ${id}`')).toEqual(['1 warning'])
      })

      // A table's or a column's name can't be a parameter. One the query quotes is told from a
      // value: between backticks anywhere, between double quotes where a table's name goes
      it.each([
        'const rows = await prisma.$queryRawUnsafe(`SELECT * FROM "${table}"`)',
        'await prisma.$executeRawUnsafe(`DELETE FROM "${modelName}"`)',
        'await prisma.$executeRawUnsafe(`INSERT INTO "${table}" (id) VALUES (1)`)',
        'await prisma.$executeRawUnsafe(`UPDATE "${table}" SET seen = true`)',
        'const rows = await prisma.$queryRawUnsafe(`SELECT u.id FROM users u\n  LEFT JOIN\n    "${table}" t ON t.id = u.id`)',
        'const rows = await prisma.$queryRawUnsafe(`SELECT count(*) FROM "public"."${table}"`)',
        'const rows = await prisma.$queryRawUnsafe(`SELECT count(*) FROM main."${table}"`)',
        'const rows = await prisma.$queryRawUnsafe(`SELECT count(*) FROM users, "${schema}".events`)',
        'const rows = await prisma.$queryRawUnsafe(`SELECT t."${column}" FROM "${table}" t`)',
        'const rows = await prisma.$queryRawUnsafe(`SELECT * FROM "tenant_${id}_events"`)',
        'const rows = await prisma.$queryRawUnsafe(`SELECT * FROM \\`${table}\\` WHERE \\`${column}\\` IS NULL`)',
        "const rows = await prisma.$queryRawUnsafe('SELECT * FROM \"' + table + '\"')",
        "const rows = await prisma.$queryRawUnsafe(`SELECT * FROM \"${table}\" WHERE note <> 'it''s'`)",
        "const rows = await prisma.$queryRawUnsafe(`SELECT * FROM \"${table}\" -- don't count the rest`)",
        'const rows = await prisma.$queryRawUnsafe(`select * from "${table}" t join "${other}" o on o.id = t.id`)',
        'const query = Prisma.raw(`SELECT * FROM "${table}"`)',
      ])('flags a query that takes in only quoted names as a warning: %s', (code) => {
        expect(found(code)).toEqual(['1 warning'])
        expect(sqlInjectionRule.check(makeFile(code), project).map(f => f.severity)).toEqual(['warning'])
      })

      it.each([
        // In MySQL and SQLite these double quotes make a string, whatever the table is quoted with
        ['a value in double quotes', 'await prisma.$executeRawUnsafe(`INSERT INTO devices VALUES ("${id}")`)'],
        ['a value in double quotes', 'const rows = await prisma.$queryRawUnsafe(`SELECT * FROM users WHERE email = "${email}"`)'],
        ['a value in double quotes', 'const rows = await prisma.$queryRawUnsafe(`SELECT * FROM "users" WHERE email = "${email}"`)'],
        ['a column a string could be', 'const rows = await prisma.$queryRawUnsafe(`SELECT "${column}" FROM users`)'],
        ['a word that only ends like FROM', 'const rows = await prisma.$queryRawUnsafe(`SELECT valid_from "${alias}" FROM prices`)'],
        ['a value next to a name', "const rows = await prisma.$queryRawUnsafe(`SELECT * FROM \"${table}\" WHERE id = '${id}'`)"],
        ['a value next to a name', 'const rows = await prisma.$queryRawUnsafe(`SELECT * FROM "${table}" LIMIT ${limit}`)'],
        ['a value next to a name', "const rows = await prisma.$queryRawUnsafe('SELECT * FROM \"' + table + '\" WHERE id = ' + id)"],
        ['a name nothing quotes', 'const rows = await prisma.$queryRawUnsafe(`SELECT * FROM ${table}`)'],
        ['double quotes inside a string', "await prisma.$executeRawUnsafe(`UPDATE docs SET meta = '{\"owner\": \"${owner}\"}' WHERE id = 1`)"],
        ['a pattern, not a name', 'const rows = await prisma.$queryRawUnsafe(`SELECT * FROM users WHERE name LIKE "%${term}%"`)'],
        ['more than a name', 'const rows = await prisma.$queryRawUnsafe(`SELECT * FROM "${table} t"`)'],
        ['a FROM that a value follows', 'const rows = await prisma.$queryRawUnsafe(`SELECT EXTRACT(YEAR FROM "${date}") AS y`)'],
        ['a FROM that a value follows', 'const rows = await prisma.$queryRawUnsafe(`SELECT TRIM(BOTH "x" FROM "${text}") AS t`)'],
        ['a FROM that a value follows', 'const rows = await prisma.$queryRawUnsafe(`SELECT * FROM users WHERE name IS DISTINCT FROM "${name}"`)'],
        ['an array of values', 'await prisma.$executeRawUnsafe(`DELETE FROM results WHERE id = ANY(ARRAY[${ids}])`)'],
        ['a quote that never closes', 'const rows = await prisma.$queryRawUnsafe(`SELECT * FROM "${table}`)'],
        ['a quote that never closes', 'const rows = await prisma.$queryRawUnsafe(`SELECT * FROM "${table}" WHERE note = \'${note}`)'],
      ])('keeps a query critical for %s: %s', (_why, code) => {
        expect(found(code)).toEqual(['1 critical'])
      })

      it('looks only right before each name, however many the query has', () => {
        const joins = ' JOIN "${other}" ON true'.repeat(20000)
        const started = performance.now()
        expect(found('const rows = await prisma.$queryRawUnsafe(`SELECT 1 FROM "${table}"' + joins + '`)')).toEqual(['1 warning'])
        expect(found('const rows = await prisma.$queryRawUnsafe(`SELECT 1 FROM "${table}"' + joins + ' WHERE id = ${id}`)')).toEqual(['1 critical'])
        expect(performance.now() - started).toBeLessThan(2000)
      })
    })

    // const query = `...${id}`; prisma.$queryRawUnsafe(query): the string is read where the file
    // sets the name, and judged as if it were written in the call
    describe('a query handed over by name', () => {
      const check = (code: string, p = prismaProject) => sqlInjectionRule.check(makeFile(code), p)
      const lines = (code: string, p = prismaProject) => check(code, p).map(f => `${f.line} ${f.severity}`)
      /** "line severity" of each finding, with and without Prisma in package.json: it has to be the same */
      const found = (code: string) => {
        expect(lines(code, project)).toEqual(lines(code))
        return lines(code)
      }
      /** What the patterns say of a string nothing follows: a warning where Prisma is listed, critical where it isn't */
      const leftToPatterns = (code: string, line: number) => {
        expect(lines(code)).toEqual([`${line} warning`])
        expect(lines(code, project)).toEqual([`${line} critical`])
      }

      it('reports the string where it is, with the message of the call', () => {
        // As Prisma's documentation writes its example of what not to do
        const code = [
          "const query = `SELECT id, name FROM \"User\" WHERE name = '${input}'`",
          'const result = await prisma.$queryRawUnsafe(query)',
        ].join('\n')
        const findings = check(code)
        expect(findings).toHaveLength(1)
        expect(findings[0]).toMatchObject({ line: 1, severity: 'critical' })
        expect(findings[0].message).toBe('$queryRawUnsafe() query built with template literal interpolation — use the $queryRaw tagged template or pass values as parameters')
        expect(findings[0].fix).toContain('prisma.$queryRaw`')
        expect(found(code)).toEqual(['1 critical'])
      })

      it('reads a query the patterns miss: in lower case, over several lines', () => {
        const code = [
          'async function find(email: string) {',
          '  const sql = `',
          '    select * from users',
          "    where email = '${email}'",
          '  `',
          '  return prisma.$queryRawUnsafe(sql)',
          '}',
        ].join('\n')
        expect(found(code)).toEqual(['2 critical'])
      })

      it('reports a query that spans lines once, where it starts', () => {
        // On its own, the UPDATE line reads as a concatenation
        const code = [
          'const sql = `',
          '  UPDATE users SET credits = credits + 1',
          "  WHERE email = '${email}'",
          '`',
          'await prisma.$executeRawUnsafe(sql)',
        ].join('\n')
        expect(found(code)).toEqual(['1 critical'])
      })

      it('reports a concatenation', () => {
        const code = [
          "const sql = 'DELETE FROM users WHERE id = ' + id",
          'await tx.$executeRawUnsafe(sql)',
        ].join('\n')
        expect(found(code)).toEqual(['1 critical'])
        expect(check(code)[0].message).toContain('$executeRawUnsafe() query built with string concatenation')
      })

      it.each([
        ['values are passed after the name', 'const sql = `SELECT * FROM "${table}" WHERE id = $1`', 'const rows = await prisma.$queryRawUnsafe(sql, id)'],
        ['the values are spread', 'const sql = `SELECT * FROM users WHERE ${where}`', 'const rows = await prisma.$queryRawUnsafe(sql, ...params)'],
        ['the statement takes no values', 'const sql = `TRUNCATE TABLE "${table}" CASCADE`', 'await prisma.$executeRawUnsafe(sql)'],
        ['the string starts with a value', 'const sql = `${baseQuery} LIMIT ${limit}`', 'const rows = await prisma.$queryRawUnsafe(sql)'],
      ])('makes it a warning when %s', (_why, declaration, call) => {
        expect(found(`${declaration}\n${call}`)).toEqual(['1 warning'])
      })

      it('tells a quoted name from a value, as in the call', () => {
        const call = '\nconst rows = await prisma.$queryRawUnsafe(sql)'
        expect(found('const sql = `SELECT * FROM "${table}"`' + call)).toEqual(['1 warning'])
        expect(found('const sql = `SELECT * FROM \\`${table}\\` WHERE \\`${column}\\` IS NULL`' + call)).toEqual(['1 warning'])
        expect(found('const sql = `SELECT * FROM "${table}" WHERE id = ${id}`' + call)).toEqual(['1 critical'])
        expect(found('const sql = `SELECT * FROM users WHERE email = "${email}"`' + call)).toEqual(['1 critical'])
      })

      it('judges a tag called with a name, and Prisma.raw(), as the call does', () => {
        const tag = [
          'const sql = `SELECT * FROM users WHERE id = ${id}`',
          'const rows = await prisma.$queryRaw(sql)',
        ].join('\n')
        expect(found(tag)).toEqual(['1 warning'])
        expect(check(tag)[0].message).toContain('$queryRaw() called with a string built with template literal interpolation')
        const raw = [
          'const order = `"${column}" ${direction}`',
          'const rows = await prisma.$queryRaw`SELECT * FROM users ORDER BY ${Prisma.raw(order)}`',
        ].join('\n')
        expect(found(raw)).toEqual(['1 warning'])
        expect(check(raw)[0].message).toContain('Prisma.raw() string built with template literal interpolation')
        // A whole statement that takes values
        expect(found('const sql = `SELECT * FROM users WHERE id = ${id}`\nconst rows = await prisma.$queryRaw(Prisma.raw(sql))')).toEqual(['1 critical'])
      })

      it('reads the name through a cast, a ! and parentheses', () => {
        const declaration = 'const sql = `SELECT * FROM users WHERE id = ${id}`\n'
        expect(found(declaration + 'const rows = await prisma.$queryRawUnsafe<User[]>((sql) as string)')).toEqual(['1 critical'])
        expect(found(declaration + 'const rows = await prisma.$queryRawUnsafe(sql!)')).toEqual(['1 critical'])
      })

      it('reads both branches of a ?: the name is set to', () => {
        const code = [
          'const sql = all',
          '  ? `SELECT * FROM videos WHERE id < ${lastSeenId}`',
          "  : `SELECT * FROM videos WHERE kind = '${kind}'`",
          'const rows = await prisma.$queryRawUnsafe(sql)',
        ].join('\n')
        expect(found(code)).toEqual(['2 critical', '3 critical'])
      })

      describe('which declaration a name is', () => {
        it('finds a constant of the module from inside a function', () => {
          const code = [
            'const QUERY = `SELECT * FROM ${TABLE} WHERE active = true`',
            'export async function all() {',
            '  return prisma.$queryRawUnsafe(QUERY)',
            '}',
          ].join('\n')
          expect(found(code)).toEqual(['1 critical'])
        })

        it('finds a variable of the function around a callback', () => {
          const code = [
            'export async function removeAll(ids: string[]) {',
            "  const sql = `DELETE FROM users WHERE id IN (${ids.join(',')})`",
            '  return prisma.$transaction(async (tx) => {',
            '    await tx.$executeRawUnsafe(sql)',
            '  })',
            '}',
          ].join('\n')
          expect(found(code)).toEqual(['2 critical'])
        })

        it('finds a name used above the line that declares it', () => {
          const code = [
            'export async function run() {',
            '  return prisma.$queryRawUnsafe(sql)',
            '}',
            'const sql = `SELECT * FROM users WHERE id = ${id}`',
          ].join('\n')
          expect(found(code)).toEqual(['4 critical'])
        })

        it('finds a var declared in a block of its function', () => {
          const code = [
            'async function run(id) {',
            '  if (id) {',
            '    var sql = `SELECT * FROM users WHERE id = ${id}`',
            '  }',
            '  return prisma.$queryRawUnsafe(sql)',
            '}',
          ].join('\n')
          expect(found(code)).toEqual(['3 critical'])
        })

        it("keeps two functions' variables of one name apart", () => {
          const code = [
            'async function byId(id: string) {',
            '  const sql = `SELECT * FROM users WHERE id = ${id}`',
            '  return prisma.$queryRawUnsafe(sql)',
            '}',
            'async function byTable(table: string, id: string) {',
            '  const sql = `SELECT * FROM "${table}" WHERE id = $1`',
            '  return prisma.$queryRawUnsafe(sql, id)',
            '}',
            'async function bump(id: string) {',
            "  const sql = 'UPDATE posts SET views = views + 1 WHERE id = $1'",
            '  return prisma.$executeRawUnsafe(sql, id)',
            '}',
          ].join('\n')
          // The values the second call passes say nothing of the first one's query
          expect(found(code)).toEqual(['2 critical', '6 warning'])
        })

        it('keeps a block apart from the block around it', () => {
          const code = [
            'const sql = `SELECT * FROM "${table}" WHERE id = ${id}`',
            'if (dryRun) {',
            "  const sql = 'SELECT 1'",
            '  await prisma.$queryRawUnsafe(sql)',
            '}',
          ].join('\n')
          leftToPatterns(code, 1)
        })

        // Each declares `sql` again where the call is: what the module's `sql` holds isn't what's run
        it.each([
          ['a parameter', 'export async function run(sql: string) {\n  return prisma.$queryRawUnsafe(sql)\n}'],
          ["an arrow function's parameter", 'export const run = (sql: string) => prisma.$queryRawUnsafe(sql)'],
          ['a destructured parameter', 'export async function run({ sql }: Job) {\n  return prisma.$queryRawUnsafe(sql)\n}'],
          ["a method's parameter", 'export class Repo {\n  run(sql: string) {\n    return this.prisma.$queryRawUnsafe(sql)\n  }\n}'],
          ["a constructor's parameter property", 'export class Job {\n  constructor(private sql: string) {\n    prisma.$queryRawUnsafe(sql)\n  }\n}'],
          ["a loop's variable", 'for (const sql of statements) {\n  await prisma.$executeRawUnsafe(sql)\n}'],
          ['a destructured value', 'async function run() {\n  const { sql, values } = build()\n  return prisma.$queryRawUnsafe(sql, ...values)\n}'],
          ["a catch clause's parameter", 'try {\n  work()\n} catch (sql) {\n  await prisma.$executeRawUnsafe(sql)\n}'],
          ['a function of that name', 'function outer() {\n  function sql() {}\n  return prisma.$queryRawUnsafe(sql)\n}'],
          ['a function expression of that name', 'const run = function sql() {\n  return prisma.$queryRawUnsafe(sql)\n}'],
        ])('does not take the module\'s string for %s', (_what, code) => {
          leftToPatterns('const sql = `SELECT * FROM users WHERE id = ${id}`\n' + code, 1)
        })

        it('leaves a name the file imports or never declares', () => {
          const text = 'const text = `SELECT * FROM users WHERE id = ${id}`\n'
          leftToPatterns(text + "import { sql } from './queries'\nconst rows = await prisma.$queryRawUnsafe(sql)", 1)
          leftToPatterns(text + 'const rows = await prisma.$queryRawUnsafe(sql)', 1)
        })
      })

      describe('a name set more than once', () => {
        it('reads every string it is set to, each on its own', () => {
          const code = [
            'let sql: string',
            'if (all) {',
            '  sql = `SELECT * FROM videos WHERE id < ${lastSeenId}`',
            '} else {',
            '  sql = `TRUNCATE TABLE ${kind}`',
            '}',
            'await prisma.$executeRawUnsafe(sql)',
          ].join('\n')
          expect(found(code)).toEqual(['3 critical', '5 warning'])
        })

        it('reads a name used for one query after another', () => {
          const code = [
            "let sql = `insert into notes (title) values ('${title}')`",
            'await prisma.$executeRawUnsafe(sql)',
            "sql = 'select last_insert_id() + 0 as id'",
            'const [row] = await prisma.$queryRawUnsafe(sql)',
            'sql = `select * from notes where id = ${row.id}`',
            'return prisma.$queryRawUnsafe(sql)',
          ].join('\n')
          expect(found(code)).toEqual(['1 critical', '5 critical'])
        })

        it('reads what a callback sets', () => {
          const code = [
            "let sql = 'SELECT 1'",
            'filters.forEach((filter) => {',
            "  sql = `SELECT * FROM items WHERE kind = '${filter.kind}'`",
            '})',
            'const rows = await prisma.$queryRawUnsafe(sql)',
          ].join('\n')
          expect(found(code)).toEqual(['3 critical'])
        })

        it('does not read the order statements run in', () => {
          // The string set below the call counts too: in a loop it would be the next query
          const code = [
            "let sql = 'SELECT 1'",
            'await prisma.$queryRawUnsafe(sql)',
            'sql = `SELECT * FROM users WHERE id = ${id}`',
          ].join('\n')
          expect(found(code)).toEqual(['3 critical'])
        })

        it('passes its values if one of the calls it is handed to does', () => {
          // The query has places for them: the other call is for when there are none to fill
          const code = [
            "const sql = `SELECT * FROM \"${table}\" WHERE ${filters.join(' AND ')}`",
            'const rows = params.length > 0',
            '  ? await prisma.$queryRawUnsafe(sql, ...params)',
            '  : await prisma.$queryRawUnsafe(sql)',
          ].join('\n')
          expect(found(code)).toEqual(['1 warning'])
          // Whichever call comes first
          const swapped = code.replace('(sql, ...params)', '(sql)').replace(': await prisma.$queryRawUnsafe(sql)', ': await prisma.$queryRawUnsafe(sql, ...params)')
          expect(swapped).not.toBe(code)
          expect(found(swapped)).toEqual(['1 warning'])
          // No call passes any: they can only be in the text
          expect(found(code.replace('(sql, ...params)', '(sql)'))).toEqual(['1 critical'])
        })

        it('names the call of the first one in its message, or of the critical one', () => {
          const tag = 'const rows = await prisma.$queryRaw(sql)'
          const unsafe = 'const more = await prisma.$queryRawUnsafe(sql)'
          const declaration = 'const sql = `SELECT * FROM users WHERE id = ${id}`'
          // A tag called with a string is never critical: with both, the unsafe call's finding stands
          for (const code of [[declaration, tag, unsafe], [declaration, unsafe, tag]]) {
            const findings = check(code.join('\n'))
            expect(findings).toHaveLength(1)
            expect(findings[0].severity).toBe('critical')
            expect(findings[0].message).toContain('$queryRawUnsafe() query built with')
          }
          expect(check([declaration, tag, 'const more = await prisma.$executeRaw(sql)'].join('\n'))[0].message).toContain('$queryRaw() called with a string')
        })
      })

      describe('a query appended to', () => {
        it('reports it once, where it starts, as a concatenation', () => {
          const code = [
            'let sql = `SELECT id FROM posts WHERE 1=1`',
            "if (author) sql += ` AND author = '${author}'`",
            'if (sort) sql += ` ORDER BY ${sort}`',
            'const rows = await prisma.$queryRawUnsafe(sql)',
          ].join('\n')
          expect(found(code)).toEqual(['1 critical'])
          expect(check(code)[0].message).toContain('$queryRawUnsafe() query built with string concatenation')
        })

        it('does not report its pieces again', () => {
          // The patterns would take the piece on line 3 for a query of its own
          const code = [
            'let sql = `SELECT id FROM a WHERE kind = ${kind}`',
            "sql += ' UNION '",
            'sql += `SELECT id FROM b WHERE kind = ${kind}`',
            'const rows = await prisma.$queryRawUnsafe(sql)',
          ].join('\n')
          expect(found(code)).toEqual(['1 critical'])
          expect(check(code)[0].message).toContain('template literal interpolation')
          // Nor a later line of a piece, which reads as a concatenation on its own
          const spread = [
            'let sql = `SELECT id FROM a WHERE kind = ${kind}`',
            'sql += `',
            '  UNION SELECT id FROM b WHERE rank = rank + 1`',
            'const rows = await prisma.$queryRawUnsafe(sql)',
          ].join('\n')
          expect(found(spread)).toEqual(['1 critical'])
        })

        it('is a warning when the call passes its values', () => {
          const code = [
            'let sql = `DELETE FROM "${table}" WHERE tenant = $1`',
            'for (const column of columns) sql += ` AND ${column} = $${++n}`',
            'await prisma.$executeRawUnsafe(sql, ...params)',
          ].join('\n')
          expect(found(code)).toEqual(['1 warning'])
        })

        it('passes a query with only literals appended', () => {
          const code = [
            "let sql = 'SELECT * FROM orders WHERE placed_at >= ?'",
            "if (status) sql += ' AND status = ?'",
            // On its own, this piece reads as a concatenation
            "sql += ' AND id IN (SELECT id FROM vip WHERE rank = rank + 1)'",
            'const rows = await prisma.$queryRawUnsafe(sql, ...params)',
          ].join('\n')
          expect(found(code)).toEqual([])
        })

        it('appends a name or a call as it does a template', () => {
          const code = [
            "let sql = 'SELECT * FROM orders'",
            'sql += filter + order',
            'const rows = await prisma.$queryRawUnsafe(sql)',
          ].join('\n')
          expect(found(code)).toEqual(['1 critical'])
          expect(found(code.replace('filter + order', 'where(filters)'))).toEqual(['1 critical'])
        })

        it('reads what its pieces take in along with its own', () => {
          const call = '\nconst rows = await prisma.$queryRawUnsafe(sql)'
          // A quoted name where the query starts, a value in a piece
          expect(found('let sql = `SELECT * FROM "${table}" WHERE 1=1`\n' + "if (name) sql += ` AND name = '${name}'`" + call)).toEqual(['1 critical'])
          // Nothing but a quoted name, in a piece
          expect(found("let sql = 'SELECT * FROM '\n" + 'sql += `"${table}"`' + call)).toEqual(['1 warning'])
          expect(found('let sql = `SELECT * FROM "${table}"`\n' + "sql += ' ORDER BY id'" + call)).toEqual(['1 warning'])
          // A piece that isn't a string the file shows is a value, as far as this goes
          expect(found('let sql = `SELECT * FROM "${table}"`\n' + 'sql += where' + call)).toEqual(['1 critical'])
          // A quote that a piece closes: the table's name is between double quotes
          expect(found("let sql = 'SELECT * FROM \"'\n" + "sql += table\nsql += '\"'" + call)).toEqual(['1 warning'])
        })

        it('cannot say what a query that starts empty is: a warning', () => {
          // Which piece comes first isn't read, so neither is the statement
          const code = [
            "let sql = ''",
            "sql += 'SELECT * FROM users'",
            'sql += ` WHERE id = ${id}`',
            'const rows = await prisma.$queryRawUnsafe(sql)',
          ].join('\n')
          expect(found(code)).toEqual(['1 warning'])
        })

        it('reads sql = sql + … as a string of its own, which starts with a value', () => {
          const code = [
            "let sql = 'SELECT * FROM users WHERE 1=1'",
            "if (name) sql = sql + ` AND name = '${name}'`",
            'const rows = await prisma.$queryRawUnsafe(sql)',
          ].join('\n')
          expect(found(code)).toEqual(['2 warning'])
        })

        it('leaves a query that starts out of sight to the patterns', () => {
          // A parameter, then a call's result: the file doesn't show the string the pieces go on
          const piece = 'sql += `SELECT id FROM b WHERE kind = ${kind}`'
          leftToPatterns(`async function run(sql: string, kind: string) {\n  ${piece}\n  return prisma.$queryRawUnsafe(sql)\n}`, 2)
          leftToPatterns(`let sql = base()\n${piece}\nconst rows = await prisma.$queryRawUnsafe(sql)`, 2)
        })
      })

      it('passes a constant, whatever a + in its SQL looks like', () => {
        const constant = "const sql = 'UPDATE posts SET views = views + 1 WHERE id = $1'\n"
        expect(found(constant + 'await prisma.$executeRawUnsafe(sql, id)')).toEqual([])
        // On every line of it
        const spread = [
          'const sql = `',
          '  UPDATE posts SET views = views + 1',
          '  WHERE id = $1',
          '`',
          'await prisma.$executeRawUnsafe(sql, id)',
        ].join('\n')
        expect(found(spread)).toEqual([])
        // Handed to nothing of Prisma's, it's the patterns' as before
        leftToPatterns(constant + 'await db.run(sql, id)', 1)
      })

      it.each([
        ["a call's result", 'const sql = buildQuery(filters)\nconst rows = await prisma.$queryRawUnsafe(sql)\nfunction buildQuery(f) { return `SELECT * FROM t WHERE a = ${f.a}` }', 3],
        ['what a method returns of a string', 'const sql = `SELECT * FROM t WHERE a = ${a}`.trim()\nconst rows = await prisma.$queryRawUnsafe(sql)', 1],
        ['another name', 'const base = `SELECT * FROM t WHERE a = ${a}`\nconst sql = base\nconst rows = await prisma.$queryRawUnsafe(sql)', 1],
        ['a property', 'const queries = { all: `SELECT * FROM t WHERE a = ${a}` }\nconst rows = await prisma.$queryRawUnsafe(queries.all)', 1],
        ['an element of a list', 'const statements = [`DELETE FROM t WHERE a = ${a}`]\nfor (const statement of statements) await prisma.$executeRawUnsafe(statement)', 1],
        ['a string handed to another client', 'const sql = `SELECT * FROM t WHERE a = ${a}`\nconst rows = await db.query(sql)', 1],
      ])('does not follow %s', (_what, code, line) => {
        leftToPatterns(code, line)
      })
    })

    // const TABLE = 'users'; prisma.$queryRawUnsafe(`SELECT * FROM ${TABLE} ...`): a name that
    // holds a constant is read as its text, not as something the query takes in
    describe('a constant of the file', () => {
      // A query only the tree gets right, after each test's code: if the rule gave up on the tree
      // and read the text instead, it's reported, and the test fails
      const CANARY = "\nconst CANARY = 'canary'\nawait prisma.$executeRawUnsafe(`DELETE FROM ${CANARY}`)"
      const check = (code: string, p = prismaProject) => {
        const file = makeFile(code + CANARY)
        expect(file.ast, 'the test code has to parse: names are read from the tree').not.toBeNull()
        return sqlInjectionRule.check(file, p)
      }
      const lines = (code: string, p = prismaProject) => check(code, p).map(f => `${f.line} ${f.severity}`)
      /** "line severity" of each finding, with and without Prisma in package.json: it has to be the same */
      const found = (code: string) => {
        expect(lines(code, project)).toEqual(lines(code))
        return lines(code)
      }
      const run = (query: string) => `const rows = await prisma.$queryRawUnsafe(${query})`
      const users = '`SELECT * FROM ${NAME} WHERE active = true`'

      it('passes a query whose every ${} holds one', () => {
        // The patterns would report this line: it's a template with a SELECT and a ${}
        const code = [
          "const TABLE = 'users'",
          'const PAGE = 50',
          run('`SELECT * FROM ${TABLE} WHERE active = true LIMIT ${PAGE}`'),
        ].join('\n')
        expect(found(code)).toEqual([])
      })

      it('passes it written with a +, and built into a name', () => {
        const table = "const TABLE = 'users'\n"
        expect(found(table + run("'SELECT * FROM ' + TABLE + ' WHERE active = true'"))).toEqual([])
        expect(found(table + 'const sql = `SELECT * FROM ${TABLE} WHERE active = true`\n' + run('sql'))).toEqual([])
        expect(found(table + "const sql = 'SELECT * FROM ' + TABLE\n" + run('sql'))).toEqual([])
      })

      it('passes every line of it', () => {
        // On its own, the UPDATE line reads as a concatenation
        const code = [
          "const TABLE = 'posts'",
          'await prisma.$executeRawUnsafe(`',
          '  UPDATE ${TABLE} SET views = views + 1',
          '  WHERE pinned = true',
          '`)',
        ].join('\n')
        expect(found(code)).toEqual([])
      })

      it('passes the lines that declare a constant a query takes in, as it passes the query', () => {
        // On its own, the line of `recent` reads as a query built with a ${}
        const code = [
          'const DAYS = 30',
          'const recent = `SELECT user_id FROM logins WHERE age < ${DAYS}`',
          'await prisma.$executeRawUnsafe(`DELETE FROM sessions WHERE user_id NOT IN (${recent})`)',
        ].join('\n')
        expect(found(code)).toEqual([])
        // On every line of it: the third one reads as a concatenation
        const spread = [
          'const DAYS = 30',
          'const recent = `',
          '  SELECT user_id, visits + 1 AS next FROM logins',
          '  WHERE age < ${DAYS}',
          '`',
          "await prisma.$executeRawUnsafe(`DELETE FROM sessions WHERE user_id NOT IN (${recent}) AND id = '${id}'`)",
        ].join('\n')
        expect(found(spread)).toEqual(['6 critical'])
        // A name that takes something in isn't one: its line is the patterns' to read
        const built = [
          'const inner = `SELECT id FROM "${table}"`',
          'const rows = await prisma.$queryRawUnsafe(`SELECT * FROM users WHERE id IN (${inner})`)',
        ].join('\n')
        expect(lines(built)).toEqual(['1 warning', '2 critical'])
        expect(lines(built, project)).toEqual(['1 critical', '2 critical'])
        // Nor one that nothing of Prisma's takes in: both lines are the patterns', as before
        const elsewhere = code.replace('prisma.$executeRawUnsafe', 'db.run')
        expect(lines(elsewhere)).toEqual(['2 warning', '3 warning'])
        expect(lines(elsewhere, project)).toEqual(['2 critical', '3 critical'])
      })

      it('passes it handed to the tags called as functions, and to Prisma.raw()', () => {
        const table = "const TABLE = 'users'\n"
        expect(found(table + 'const rows = await prisma.$queryRaw(`SELECT * FROM ${TABLE} WHERE active = true`)')).toEqual([])
        expect(found(table + 'const rows = await prisma.$queryRaw`SELECT * FROM ${Prisma.raw(`"${TABLE}"`)} WHERE id = ${id}`')).toEqual([])
      })

      it.each([
        ['a string', "const NAME = 'users'"],
        ['a number', 'const NAME = 50'],
        ['a template with no ${}', 'const NAME = `users`'],
        ['a literal through a cast', "const NAME = 'users' as const"],
        ['a template of constants', "const SCHEMA = 'public'\nconst NAME = `${SCHEMA}.users`"],
        ['a + of constants', "const SCHEMA = 'public'\nconst NAME = SCHEMA + '.users'"],
        ['another constant', "const USERS = 'users'\nconst NAME = USERS"],
        ['a ?: between two constants', "const NAME = archived ? 'users_archive' : 'users'"],
        ['a constant, and exported', "export const NAME = 'users'"],
      ])('reads a const set to %s as a constant', (_what, declaration) => {
        expect(found(declaration + '\n' + run(users))).toEqual([])
      })

      it.each([
        ['a let', "let NAME = 'users'", ''],
        ['a var', "var NAME = 'users'", ''],
        ['an import', "import { NAME } from './tables'", ''],
        ['a name the file does not declare', '// NAME is a global', ''],
        ['a const set to what a call returns', 'const NAME = tableFor(kind)', ''],
        ['a const set to a parameter', 'export async function all(table: string) {\n  const NAME = table', '}'],
        ['a const set to a template that takes something in', 'const NAME = `users_${tenant}`', ''],
        ['a const set to a ?: with a branch that is no constant', "const NAME = archived ? archive : 'users'", ''],
        ['a const set to a number worked out', 'const NAME = 5 * 10', ''],
        ['a const taken out of an object, with a default', "const { NAME = 'users' } = options", ''],
        ['a parameter with a default', "export async function all(NAME = 'users') {", '}'],
      ])('does not take %s for a constant', (_what, before, after) => {
        expect(found(`${before}\n${run(users)}\n${after}`)).toEqual([`${before.split('\n').length + 1} critical`])
      })

      it.each([
        ['a property of an object', "const TABLES = { users: 'users' } as const", 'TABLES.users'],
        ['a member of an enum', "enum Table { Users = 'users' }", 'Table.Users'],
        ['what a call returns, of a constant too', "const TABLE = 'users'", 'quote(TABLE)'],
        ['a number worked out', 'const PAGE = 50', 'PAGE * 2'],
      ])('takes in %s, whatever it holds', (_what, declaration, held) => {
        expect(found(declaration + '\n' + run('`SELECT * FROM users LIMIT ${' + held + '}`'))).toEqual(['2 critical'])
      })

      it('takes in a name that holds a built string as one thing: what the string holds is not read', () => {
        // Read through, the query would take in a quoted name alone
        const from = 'const from = `FROM "${table}"`\n'
        expect(found(from + run("'SELECT * ' + from"))).toEqual(['2 critical'])
        expect(found(from + run('`SELECT * ${from}`'))).toEqual(['2 critical'])
      })

      it('looks the name up where the query stands', () => {
        // A parameter hides the module's constant
        const hidden = [
          "const table = 'users'",
          'export async function all(table: string) {',
          '  return prisma.$queryRawUnsafe(`SELECT * FROM ${table} WHERE active = true`)',
          '}',
        ].join('\n')
        expect(found(hidden)).toEqual(['3 critical'])
        // And a block's constant hides the parameter, in that block
        const block = [
          'export async function all(table: string) {',
          '  if (!table) {',
          "    const table = 'users'",
          '    return prisma.$queryRawUnsafe(`SELECT * FROM ${table} WHERE active = true`)',
          '  }',
          '  return prisma.$queryRawUnsafe(`SELECT * FROM ${table} WHERE active = true`)',
          '}',
        ].join('\n')
        expect(found(block)).toEqual(['6 critical'])
      })

      it('does not go round names that lead back to each other', () => {
        const code = [
          'const A = `${B} `',
          'const B = `${A} `',
          run('`SELECT * FROM ${A} WHERE active = true`'),
        ].join('\n')
        expect(found(code)).toEqual(['3 critical'])
      })

      it('reads a ?: between two constants as a constant, where it stands too', () => {
        expect(found(run("`SELECT * FROM users ORDER BY name ${descending ? 'DESC' : 'ASC'}`"))).toEqual([])
        expect(found(run("'SELECT * FROM users' + (active ? ' WHERE active = true' : '')"))).toEqual([])
        expect(found(run("`SELECT * FROM users ORDER BY ${byName ? 'name' : byDate ? 'created_at' : 'id'}`"))).toEqual([])
        // One branch takes something in: so does the ?:
        expect(found(run("`SELECT * FROM users ${name ? `WHERE name = '${name}'` : ''}`"))).toEqual(['1 critical'])
        expect(found(run("`SELECT * FROM users ORDER BY ${byName ? 'name' : column}`"))).toEqual(['1 critical'])
        // And it's one thing taken in, as it was: what its branches hold isn't read, in a + either
        expect(found(run("'SELECT * FROM ' + (archived ? `\"${table}\"` : '\"users\"')"))).toEqual(['1 critical'])
      })

      it('has nothing to read in a call with no query, or handed a number worked out', () => {
        expect(found('await prisma.$executeRawUnsafe()')).toEqual([])
        expect(found(run('page * size'))).toEqual([])
      })

      it('does not skip the line of a call for the constant it is handed by name', () => {
        // The second statement of the line is the patterns' to read, as on any line
        const code = "const SQL = 'SELECT 1'\nconst rows = await prisma.$queryRawUnsafe(SQL); const text = `SELECT * FROM users WHERE id = ${id}`"
        expect(lines(code)).toEqual(['2 warning'])
        expect(lines(code, project)).toEqual(['2 critical'])
      })

      it('passes a constant branch of an argument, and reports the other', () => {
        const code = [
          "const TABLE = 'videos'",
          'const rows = await prisma.$queryRawUnsafe(',
          '  all',
          '    ? `SELECT * FROM ${TABLE} WHERE hidden = false`',
          "    : `SELECT * FROM ${TABLE} WHERE kind = '${kind}'`",
          ')',
        ].join('\n')
        expect(found(code)).toEqual(['5 critical'])
        // The same for a name set to one
        const named = [
          "const TABLE = 'videos'",
          'const sql = all',
          '  ? `SELECT * FROM ${TABLE} WHERE hidden = false`',
          "  : `SELECT * FROM ${TABLE} WHERE kind = '${kind}'`",
          run('sql'),
        ].join('\n')
        expect(found(named)).toEqual(['4 critical'])
      })

      // for (const table of ['sessions', 'tokens']): the fixed list a table's name is checked against
      describe('the variable of a for…of loop', () => {
        const loop = (head: string, query = '`DELETE FROM ${table} WHERE stale = true`') =>
          `for (${head}) {\n  await prisma.$executeRawUnsafe(${query})\n}`
        const listed = "const TABLES = ['sessions', 'tokens']\n"

        it('is a constant over a list of constants written in the loop', () => {
          expect(found(loop("const table of ['sessions', 'tokens']"))).toEqual([])
          expect(found(loop("const table of ['sessions', 'tokens'] as const"))).toEqual([])
          expect(found(loop('const days of [7, 30]', '`DELETE FROM sessions WHERE age > ${days}`'))).toEqual([])
        })

        it('is a constant over a list a const holds', () => {
          expect(found(listed + loop('const table of TABLES'))).toEqual([])
          expect(found("const TABLES = ['sessions', 'tokens'] as const\n" + loop('const table of TABLES'))).toEqual([])
          // A list of names, each a constant
          expect(found("const SESSIONS = 'sessions'\nconst TABLES = [SESSIONS, `${SESSIONS}_archive`]\n" + loop('const table of TABLES'))).toEqual([])
        })

        it('is taken in over a list with nothing in it, which has no text to read', () => {
          expect(found(loop('const table of []'))).toEqual(['2 critical'])
          expect(found('const TABLES: string[] = []\n' + loop('const table of TABLES'))).toEqual(['3 critical'])
        })

        it('is one in a query built into a name, and next to other constants', () => {
          const code = [
            "const SCHEMA = 'app'",
            "for (const table of ['sessions', 'tokens']) {",
            '  const sql = `DELETE FROM ${SCHEMA}.${table} WHERE stale = true`',
            '  await prisma.$executeRawUnsafe(sql)',
            '}',
          ].join('\n')
          expect(found(code)).toEqual([])
        })

        it.each([
          ['is empty where it is declared', 'const TABLES: string[] = []\nfor (const row of rows) TABLES.push(row.name)', ''],
          ['is added to', "const TABLES = ['sessions']\nif (extra) TABLES.push(extra)", ''],
          ['is set by index', "const TABLES = ['sessions']\nTABLES[0] = extra", ''],
          ['is handed to a call', "const TABLES = ['sessions']\nextend(TABLES)", ''],
          ['is given another name', "const TABLES = ['sessions']\nconst more = TABLES\nmore.push(extra)", ''],
          ['is put into an object', "const TABLES = ['sessions']\nconst config = { TABLES }", ''],
          ['is put into an object under another key', "const TABLES = ['sessions']\nconst config = { list: TABLES }", ''],
          ['is a key of something', "const TABLES = ['sessions']\nconst label = labels[TABLES]", ''],
          ['is a key worked out', "const TABLES = ['sessions']\nconst index = { [TABLES]: true }", ''],
          ['is taken out of an object', 'const { TABLES } = config', ''],
          ['is exported', "export const TABLES = ['sessions']", ''],
          ['is exported below', "const TABLES = ['sessions']\nexport { TABLES }", ''],
          ['holds a name that is no constant', "const TABLES = ['sessions', extra]", ''],
          ['holds a spread', "const TABLES = ['sessions', ...more]", ''],
          ['has a hole', "const TABLES = ['sessions', , 'tokens']", ''],
          ['is held by a let', "let TABLES = ['sessions']", ''],
          ['is what a call returns', "const TABLES = ['sessions'].concat(more)", ''],
          ['is another name', "const BASE = ['sessions']\nconst TABLES = BASE", ''],
          ['is a parameter', 'export async function clean(TABLES: string[]) {', '}'],
        ])('is taken in when the list %s', (_why, before, after) => {
          expect(found(`${before}\n${loop('const table of TABLES')}\n${after}`)).toEqual([`${before.split('\n').length + 2} critical`])
        })

        it.each([
          ['its length', 'console.log(TABLES.length)'],
          ['a search of it', 'const known = (name: string) => TABLES.includes(name)'],
          ['a copy of it', 'const quoted = TABLES.map(name => `"${name}"`)'],
          ['a read past a ?.', 'const first = TABLES?.find(Boolean)'],
          ['another loop over it', 'for (const table of TABLES) console.log(table)'],
          ['a type made of it', 'type Table = (typeof TABLES)[number]'],
          ['a property of that name', 'const count = stats.TABLES'],
          ['a key of that name', 'const stats = { TABLES: 2 }'],
          ['an export of something else', "export const OTHER = ['other']"],
        ])('still is one when the file has %s', (_what, line) => {
          expect(found(listed + line + '\n' + loop('const table of TABLES'))).toEqual([])
        })

        it('goes by the name: a push() to anything called that says no', () => {
          const code = [
            listed + loop('const table of TABLES'),
            'function collect(TABLES: string[], extra: string) {',
            '  TABLES.push(extra)',
            '}',
          ].join('\n')
          expect(found(code)).toEqual(['3 critical'])
        })

        it.each([
          ['a let', 'let table of TABLES'],
          ['a var', 'var table of TABLES'],
          ['taken out of each element', 'const [table] of TABLES'],
          ['the key of a for…in', 'const table in TABLES'],
        ])('is taken in when it is %s', (_what, head) => {
          expect(found(listed + loop(head))).toEqual(['3 critical'])
        })

        it('is taken in when it was declared before the loop', () => {
          expect(found(listed + 'let table: string\n' + loop('table of TABLES'))).toEqual(['4 critical'])
        })

        it('is not what a const with no value is, for the file having a loop', () => {
          const code = [
            'const { table } = options',
            "for (const other of ['sessions', 'tokens']) console.log(other)",
            'await prisma.$executeRawUnsafe(`DELETE FROM ${table} WHERE stale = true`)',
          ].join('\n')
          expect(found(code)).toEqual(['3 critical'])
        })

        it('is not the name a callback or a block declares again', () => {
          const code = [
            "for (const table of ['sessions', 'tokens']) {",
            '  await each(async (table: string) => prisma.$executeRawUnsafe(`DELETE FROM ${table} WHERE stale = true`))',
            '}',
          ].join('\n')
          expect(found(code)).toEqual(['2 critical'])
        })
      })

      it('reads a name that can be many texts in its first few', () => {
        // Each name is either of the one before: twice as many texts a name, 2^27 in the end,
        // and as many readings of N0 if each name were read again each time it's met
        const names = ["const N0 = flag ? 'a' : 'b'"]
        for (let i = 1; i <= 26; i++) names.push(`const N${i} = flag ? N${i - 1} : N${i - 1}`)
        const started = performance.now()
        expect(found(names.join('\n') + '\n' + run('`SELECT * FROM ${N26} WHERE id = ${id}`'))).toEqual(['28 critical'])
        expect(found(names.join('\n') + '\n' + run('`SELECT * FROM ${N26} WHERE active = true`'))).toEqual([])
        expect(performance.now() - started).toBeLessThan(2000)
      })

      describe('read as its text', () => {
        it('shows the statement of a query that starts with one', () => {
          const base = "const BASE = 'SELECT * FROM users'\n"
          // A string that starts with a ${} was a warning: its statement couldn't be seen
          expect(found(base + run('`${BASE} WHERE id = ${id}`'))).toEqual(['2 critical'])
          expect(found(base + run("BASE + ' WHERE id = ' + id"))).toEqual(['2 critical'])
          expect(found(base + 'const sql = `${BASE} WHERE id = ${id}`\n' + run('sql'))).toEqual(['2 critical'])
          // As for any statement that takes values: a warning when they're passed
          expect(found(base + 'const rows = await prisma.$queryRawUnsafe(`${BASE} WHERE ${filter}`, id)')).toEqual(['2 warning'])
          // One that takes none
          expect(found("const BASE = 'TRUNCATE TABLE'\n" + 'await prisma.$executeRawUnsafe(`${BASE} ${table}`)')).toEqual(['2 warning'])
          // And a start that's out of sight is still one: a warning, as it was
          expect(found("import { BASE } from './queries'\n" + run('`${BASE} WHERE id = ${id}`'))).toEqual(['2 warning'])
        })

        it('reads the statement across the pieces of a +', () => {
          // The first piece alone says nothing: the statement is in the second
          expect(found(run("'(' + 'SELECT id FROM users WHERE id = ' + id + ')'"))).toEqual(['1 critical'])
          // But not past what's taken in: a statement that follows it isn't how the query starts
          expect(found(run("prefix + 'SELECT * FROM users WHERE id = ' + id"))).toEqual(['1 warning'])
          expect(found(run('`${prefix} SELECT * FROM users WHERE id = ${id}`'))).toEqual(['1 warning'])
        })

        it('reads the statement past a comment, whatever the comment takes in', () => {
          expect(found(run('`/* for ${tenant} */ SELECT * FROM users WHERE id = ${id}`'))).toEqual(['1 critical'])
          expect(found(run('`-- for ${tenant}\nSELECT * FROM users WHERE id = ${id}`'))).toEqual(['1 critical'])
          // One that never closes holds the rest, as it did
          expect(found(run('`/* for ${tenant} SELECT * FROM users WHERE id = ${id}`'))).toEqual(['1 warning'])
        })

        it('tells a quoted name from a value with the constant in its place', () => {
          const page = 'const PAGE = 50\n'
          // LIMIT ${PAGE} read as a value next to the name
          expect(found(page + run('`SELECT * FROM "${table}" LIMIT ${PAGE}`'))).toEqual(['2 warning'])
          expect(found(page + run("'SELECT * FROM \"' + table + '\" LIMIT ' + PAGE"))).toEqual(['2 warning'])
          expect(found(page + run('`SELECT * FROM "${table}" WHERE id = ${id} LIMIT ${PAGE}`'))).toEqual(['2 critical'])
          // A number written in a + is text too
          expect(found(run("'SELECT * FROM \"' + table + '\" LIMIT ' + 50"))).toEqual(['1 warning'])
          // The quotes in a constant are the query's: a string it holds, a name it opens
          expect(found("const ACTIVE = `status = 'active'`\n" + run('`SELECT * FROM "${table}" WHERE ${ACTIVE}`'))).toEqual(['2 warning'])
          expect(found("const SCHEMA = '\"public\".\"'\n" + run('`SELECT count(*) FROM ${SCHEMA}${table}"`'))).toEqual(['2 warning'])
          // And a value between the quotes one opens is still a value
          expect(found("const WHERE = `WHERE name = '`\n" + run('`SELECT * FROM "users" ${WHERE}${name}\'`'))).toEqual(['2 critical'])
          expect(found("const WHERE = 'WHERE email = '\n" + run('`SELECT * FROM "users" ${WHERE}"${email}"`'))).toEqual(['2 critical'])
        })

        it('is critical if one of the texts a ?: makes it is', () => {
          // EXPLAIN isn't a statement values go into; without it, the SELECT is
          expect(found(run("`${plan ? 'EXPLAIN ' : ''}SELECT * FROM users WHERE id = ${id}`"))).toEqual(['1 critical'])
          expect(found(run("`${plan ? '' : 'EXPLAIN '}SELECT * FROM users WHERE id = ${id}`"))).toEqual(['1 critical'])
          expect(found(run("`${plan ? 'EXPLAIN ' : 'EXPLAIN ANALYZE '}SELECT * FROM users WHERE id = ${id}`"))).toEqual(['1 warning'])
          // Quoted in one text, bare in the other
          expect(found(run("`SELECT * FROM ${quoted ? '\"' : ''}${table}${quoted ? '\"' : ''}`"))).toEqual(['1 critical'])
          expect(found("const tail = quoted ? '\"' : ''\n" + run('`SELECT * FROM "${table}${tail}`'))).toEqual(['2 critical'])
          // The same in a +
          expect(found(run("(plan ? 'EXPLAIN ' : '') + 'SELECT * FROM users WHERE id = ' + id"))).toEqual(['1 critical'])
          expect(found(run("(plan ? '' : 'EXPLAIN ') + 'SELECT * FROM users WHERE id = ' + id"))).toEqual(['1 critical'])
        })

        it('reads a ?: written twice, or a name used twice, the same way both times', () => {
          // One quote or the other around the name, never one of each
          expect(found(run("`SELECT * FROM ${mysql ? '`' : '\"'}${table}${mysql ? '`' : '\"'}`"))).toEqual(['1 warning'])
          expect(found("const quote = mysql ? '`' : '\"'\n" + run('`SELECT * FROM ${quote}${table}${quote}`'))).toEqual(['2 warning'])
          expect(found("const quote = mysql ? '`' : '\"'\n" + run("'SELECT * FROM ' + quote + table + quote"))).toEqual(['2 warning'])
          // With a list between them that's longer than the two
          const code = [
            "const quote = mysql ? '`' : '\"'",
            "for (const schema of ['a', 'b', 'c']) {",
            '  await prisma.$queryRawUnsafe(`SELECT * FROM ${schema}.${quote}${table}${quote}`)',
            '}',
          ].join('\n')
          expect(found(code)).toEqual(['3 warning'])
        })

        it('reads what is appended to a query, and a query that starts as a name', () => {
          const base = "const BASE = 'SELECT * FROM users'\n"
          // A constant appended is no more built into it than a literal
          expect(found(base + "const ORDER = ' ORDER BY id'\nlet sql = BASE\nsql += ORDER\n" + run('sql'))).toEqual([])
          // A value appended: one query, reported where it starts, with the statement the name holds
          expect(found(base + 'let sql = BASE\nsql += ` WHERE id = ${id}`\n' + run('sql'))).toEqual(['2 critical'])
          expect(check(base + 'let sql = BASE\nsql += ` WHERE id = ${id}`\n' + run('sql'))[0].message).toContain('built with string concatenation')
          // The statement can be all the query starts as
          expect(found("let sql = 'DELETE'\nsql += ` FROM users WHERE id = ${id}`\n" + run('sql'))).toEqual(['1 critical'])
          // And the quotes of a constant that's appended: the table's name is between them
          expect(found("const QUOTE = '\"'\nlet sql = 'SELECT * FROM '\nsql += QUOTE\nsql += table\nsql += QUOTE\n" + run('sql'))).toEqual(['2 warning'])
        })
      })
    })

    describe('what the regex fallback has to get right', () => {
      const found = (code: string, relativePath = 'test.ts') => {
        const file = makeFile(code, { relativePath })
        expect(file.ast, 'this file is meant not to parse').toBeNull()
        return sqlInjectionRule.check(file, project).map(f => `${f.line} ${f.severity}`)
      }
      const text = (code: string) => sqlInjectionRule.check(makeFile(code, { withAst: false }), project).map(f => `${f.line} ${f.severity}`)

      it('reads a file Babel cannot parse', () => {
        // A type argument in a .js file
        const code = [
          'const rows = await prisma.$queryRaw<User[]>`SELECT * FROM users WHERE id = ${id}`',
          'const more = await prisma.$queryRawUnsafe<User[]>(`SELECT * FROM users WHERE id = ${id}`)',
        ].join('\n')
        expect(found(code, 'db.js')).toEqual(['2 critical'])
      })

      it('skips only the opening line of a template that never closes', () => {
        const code = [
          'const text = "SELECT * FROM users WHERE id = " + id',
          'const rows = await prisma.$queryRaw`SELECT * FROM users WHERE id = ${id}',
          'const more = "SELECT * FROM users WHERE id = " + id',
        ].join('\n')
        expect(found(code)).toEqual(['1 critical', '3 critical'])
      })

      it('does not take a mention in a string for a tag', () => {
        // Read as a tag, the backtick after the name would open a template that runs into line 2
        const code = [
          'const hint = "the tag is `prisma.$queryRaw`"',
          'const query = `SELECT * FROM users WHERE id = ${id}`',
        ].join('\n')
        expect(text(code)).toEqual(['2 critical'])
        // Counted across the matches of one line, and from zero on the next
        const twice = [
          'const hint = "prisma.$queryRaw`SELECT 1` is a tag, `prisma.$executeRaw` too"',
          'const query = `SELECT * FROM users WHERE id = ${id}`',
          'const rows = await prisma.$queryRaw`SELECT * FROM users WHERE id = ${id}`',
        ].join('\n')
        expect(text(twice)).toEqual(['2 critical'])
      })

      it('reads a line with many queries in linear time', () => {
        const line = 'await prisma.$queryRaw`SELECT 1`; '.repeat(20000)
        const started = performance.now()
        expect(text(line + '\nconst query = `SELECT * FROM users WHERE id = ${id}`')).toEqual(['2 critical'])
        expect(performance.now() - started).toBeLessThan(2000)
      })

      it('does not read a comment', () => {
        const code = [
          '// call it as a tag: prisma.$queryRaw`',
          'const query = `SELECT * FROM users WHERE id = ${id}`',
        ].join('\n')
        expect(text(code)).toEqual(['2 critical'])
      })

      // What a template holds can look like its end. The second line reads as a concatenation
      // on its own, so it's reported if the template is cut short
      it.each([
        ['a template in an interpolation', "${`it's ${kind}`}"],
        ['braces in an interpolation', '${tags.map((tag) => { return tag.trim() }).join(`,`)}'],
        ['an escaped backtick', '\\`${kind}\\`'],
      ])('reads a template to its end past %s', (_what, value) => {
        const code = [
          'const rows = await prisma.$queryRaw`SELECT * FROM users WHERE kind = ' + value,
          '  OR id IN (SELECT id FROM vip WHERE rank = rank + 1)`',
        ].join('\n')
        expect(text(code)).toEqual([])
      })

      it('reads a concatenation as far as it can', () => {
        // What follows the + is in parentheses: not a literal, whatever it is
        const code = 'const rows = await prisma.$queryRawUnsafe(`SELECT id FROM "${table}"` + (where ? ` WHERE ${where}` : ""))'
        expect(sqlInjectionRule.check(makeFile(code, { withAst: false }), prismaProject).map(f => `${f.line} ${f.severity}`)).toEqual(['1 critical'])
      })

      it('finds the values a call passes past what it cannot read', () => {
        const code = [
          'const rows = await prisma.$queryRawUnsafe(',
          '  `SELECT "id" FROM "${toTable(key)}"` +',
          "    (where.length ? ` WHERE ${where.join(' AND ')}` : '') +",
          "    `, (SELECT 1) LIMIT ${limit}`,",
          '  ...params,',
          ')',
        ].join('\n')
        expect(text(code)).toEqual(['2 warning'])
        // A comma inside parentheses, brackets or a string passes nothing
        expect(text("await prisma.$executeRawUnsafe(`DELETE FROM users WHERE id = ${id}` + (a, ' ,b'))")).toEqual(['1 critical'])
        expect(text("await prisma.$executeRawUnsafe(`DELETE FROM users WHERE id = ${id}` + [a, b].join(''))")).toEqual(['1 critical'])
        expect(text("const rows = await prisma.$queryRawUnsafe('SELECT id, name FROM users WHERE id = ' + id)")).toEqual(['1 critical'])
        // Nor does one after the call's `)`
        expect(text('const rows = await prisma.$queryRawUnsafe(`SELECT * FROM users WHERE id = ${id}`)\nlog(rows, id)')).toEqual(['1 critical'])
      })

      it('does not tell a quoted name from a value: a statement that takes values stays critical', () => {
        expect(text('const rows = await prisma.$queryRawUnsafe(`SELECT * FROM "${table}"`)')).toEqual(['1 critical'])
      })

      it('does not read what a name holds: without a tree there are no scopes', () => {
        const code = "const TABLE = 'users'\nconst rows = await prisma.$queryRawUnsafe(`SELECT * FROM ${TABLE} WHERE active = true`)"
        expect(text(code)).toEqual(['2 critical'])
        expect(sqlInjectionRule.check(makeFile(code), project)).toEqual([])
      })

      it('leaves a query it cannot read to the patterns', () => {
        // A quote in a regex literal: the string's end isn't found
        const code = "await prisma.$executeRawUnsafe(`DELETE FROM jobs WHERE status = '${status.replace(/'/g, \"''\")}'`)"
        expect(text(code)).toEqual(['1 critical'])
        expect(sqlInjectionRule.check(makeFile(code, { withAst: false }), prismaProject).map(f => f.severity)).toEqual(['warning'])
      })
    })
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
