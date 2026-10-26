import { describe, it, expect } from 'vitest'
import { redirectInTryCatchRule } from '../../src/rules/redirect-in-try-catch.js'
import { makeFile, makeProject } from '../helpers.js'

const project = makeProject()

describe('redirect-in-try-catch rule', () => {
  it('detects redirect inside try block', () => {
    const file = makeFile(`
try {
  await db.insert(data)
  redirect('/dashboard')
} catch (e) {
  console.error(e)
}`)
    const findings = redirectInTryCatchRule.check(file, project)
    expect(findings.length).toBeGreaterThan(0)
    expect(findings[0].ruleId).toBe('redirect-in-try-catch')
    expect(findings[0].severity).toBe('critical')
  })

  it('allows redirect outside try/catch', () => {
    const file = makeFile(`
await db.insert(data)
redirect('/dashboard')
`)
    const findings = redirectInTryCatchRule.check(file, project)
    expect(findings).toHaveLength(0)
  })

  it('ignores redirect in comments', () => {
    const file = makeFile(`
try {
  // redirect('/dashboard')
} catch (e) {}
`)
    const findings = redirectInTryCatchRule.check(file, project)
    expect(findings).toHaveLength(0)
  })

  it('skips test files', () => {
    const file = makeFile(`
try {
  redirect('/dashboard')
} catch (e) {}
`, { relativePath: 'tests/test.ts' })
    const findings = redirectInTryCatchRule.check(file, project)
    expect(findings).toHaveLength(0)
  })

  it('provides a fix suggestion', () => {
    const file = makeFile(`
try {
  redirect('/dashboard')
} catch (e) {}
`)
    const findings = redirectInTryCatchRule.check(file, project)
    expect(findings[0].fix).toBeTruthy()
  })

  // Only Next's bare redirect() throws; res.redirect() and NextResponse.redirect() return
  it('does not flag Express res.redirect() or NextResponse.redirect()', () => {
    const file = makeFile(`
app.post('/login', async (req, res) => {
  try {
    await signIn(req.body)
    res.redirect('/home')
  } catch (err) {
    res.status(500).send('Login failed')
  }
})

export async function GET(request) {
  try {
    return NextResponse.redirect(new URL('/home', request.url))
  } catch (err) {
    return new Response('error', { status: 500 })
  }
}`)
    expect(file.ast).toBeTruthy()
    const findings = redirectInTryCatchRule.check(file, project)
    expect(findings).toHaveLength(0)
  })

  // A redirect thrown from a catch block propagates; only the try block's is swallowed
  it('does not flag redirect() inside the catch block', () => {
    const file = makeFile(`
try {
  await db.insert(data)
} catch (e) {
  redirect('/error')
}`)
    const findings = redirectInTryCatchRule.check(file, project)
    expect(findings).toHaveLength(0)
  })

  it('flags a catch block redirect when an outer try swallows it', () => {
    const file = makeFile(`
try {
  try {
    await db.insert(data)
  } catch (e) {
    redirect('/error')
  }
} catch (outer) {
  console.error(outer)
}`)
    const findings = redirectInTryCatchRule.check(file, project)
    expect(findings).toHaveLength(1)
    expect(findings[0].line).toBe(6)
  })

  it('does not flag redirect() after a one-line catch block', () => {
    const file = makeFile(`
try {
  await db.insert(data)
} catch (e) { console.error(e) }
redirect('/dashboard')
`)
    const findings = redirectInTryCatchRule.check(file, project)
    expect(findings).toHaveLength(0)
  })

  it('does not flag try/finally, which catches nothing', () => {
    const file = makeFile(`
try {
  redirect('/dashboard')
} finally {
  await db.disconnect()
}`)
    const findings = redirectInTryCatchRule.check(file, project)
    expect(findings).toHaveLength(0)
  })

  // The rule's own fix: re-throw redirect errors from the catch
  it('allows a catch that re-throws redirect errors', () => {
    const file = makeFile(`
try {
  redirect('/a')
} catch (e) {
  if (e instanceof Error && e.message === "NEXT_REDIRECT") throw e
  console.error(e)
}
try {
  redirect('/b')
} catch (error) {
  unstable_rethrow(error)
  console.error(error)
}
try {
  redirect('/c')
} catch (error) {
  console.error(error)
  throw error
}`)
    const findings = redirectInTryCatchRule.check(file, project)
    expect(findings).toHaveLength(0)
  })

  it('falls back to regex with the same try/catch boundaries', () => {
    const file = makeFile(`
try {
  res.redirect('/home')
  redirect('/dashboard')
} catch (e) {
  redirect('/error')
}
redirect('/after')`, { withAst: false })
    const findings = redirectInTryCatchRule.check(file, project)
    expect(findings).toHaveLength(1)
    expect(findings[0].line).toBe(4)
  })
})
