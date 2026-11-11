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

      it('leaves a query built elsewhere to the patterns', () => {
        const code = [
          'const query = `SELECT * FROM users WHERE id = ${id}`',
          'const rows = await prisma.$queryRawUnsafe(query)',
        ].join('\n')
        expect(check(code, prismaProject).map(f => `${f.line} ${f.severity}`)).toEqual(['1 warning'])
      })

      it('flags $queryRaw() called with a plain template', () => {
        const findings = check('const rows = await prisma.$queryRaw(`SELECT * FROM users WHERE id = ${id}`)', prismaProject)
        expect(findings).toHaveLength(1)
        expect(findings[0]).toMatchObject({ line: 1, severity: 'critical' })
        expect(findings[0].message).toBe('$queryRaw() called with a string built with template literal interpolation — only its tagged template sends values as parameters')
        expect(findings[0].fix).toContain('prisma.$queryRaw`')
      })

      it('flags $executeRaw() called with a concatenation', () => {
        const findings = check("await prisma.$executeRaw('DELETE FROM users WHERE id = ' + id)", prismaProject)
        expect(findings).toHaveLength(1)
        expect(findings[0].severity).toBe('critical')
        expect(findings[0].message).toContain('$executeRaw() called with a string built with string concatenation')
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
