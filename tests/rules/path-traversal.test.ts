import { describe, it, expect } from 'vitest'
import { pathTraversalRule } from '../../src/rules/path-traversal.js'
import { makeFile, makeProject } from '../helpers.js'

const project = makeProject()

describe('path-traversal rule', () => {
  it('detects readFile with req.query path', () => {
    const file = makeFile(`const content = await readFile(req.query.path)`)
    const findings = pathTraversalRule.check(file, project)
    expect(findings).toHaveLength(1)
    expect(findings[0].severity).toBe('critical')
  })

  it('detects readFileSync with req.body path', () => {
    const file = makeFile(`const data = readFileSync(req.body.filePath)`)
    const findings = pathTraversalRule.check(file, project)
    expect(findings).toHaveLength(1)
  })

  it('detects path.join with user input', () => {
    const file = makeFile(`const full = path.join(dir, req.query.file)`)
    const findings = pathTraversalRule.check(file, project)
    expect(findings).toHaveLength(1)
  })

  it('allows readFile with sanitization', () => {
    const file = makeFile(`
const resolved = path.resolve(base, input)
if (!resolved.startsWith(path.resolve(base))) throw new Error()
const data = await readFile(resolved)
`)
    const findings = pathTraversalRule.check(file, project)
    expect(findings).toHaveLength(0)
  })

  it('skips test files', () => {
    const file = makeFile(`readFile(req.query.path)`, { relativePath: 'tests/fs.test.ts' })
    const findings = pathTraversalRule.check(file, project)
    expect(findings).toHaveLength(0)
  })

  it('detects sendFile with user input', () => {
    const file = makeFile(`res.sendFile(req.params.file)`)
    const findings = pathTraversalRule.check(file, project)
    expect(findings).toHaveLength(1)
  })

  // AST improvement: "sanitize" in comment doesn't suppress findings
  it('AST: flags readFile(req.query.file) even with "sanitize" in comment', () => {
    const file = makeFile([
      '// TODO: sanitize user input before use',
      'const data = await readFile(req.query.file)',
    ].join('\n'))
    const findings = pathTraversalRule.check(file, project)
    expect(findings).toHaveLength(1)
  })

  // AST improvement: static string is safe
  it('AST: skips readFile with static string path', () => {
    const file = makeFile(`const data = await readFile("./config.json")`)
    const findings = pathTraversalRule.check(file, project)
    expect(findings).toHaveLength(0)
  })

  // AST: regex fallback still works
  it('falls back to regex when AST is unavailable', () => {
    const file = makeFile(`const data = readFile(req.query.path)`, { withAst: false })
    const findings = pathTraversalRule.check(file, project)
    expect(findings).toHaveLength(1)
    expect(findings[0].severity).toBe('critical')
  })
})
