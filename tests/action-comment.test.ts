import { describe, it, expect } from 'vitest'
import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const require = createRequire(import.meta.url)
const SCRIPT = join(__dirname, '..', 'scripts', 'action-comment.cjs')
const { buildComment, inlineCode } = require(SCRIPT) as {
  buildComment: (result: unknown) => string
  inlineCode: (value: string) => string
}

function resultWith(findings: Array<{ ruleId?: string; file?: string; line?: number; message: string }>) {
  return {
    overallScore: 72,
    filesScanned: 3,
    scanDurationMs: 40,
    categoryScores: [
      { category: 'security', score: 90, findingCount: 1 },
      { category: 'reliability', score: 50, findingCount: 2 },
    ],
    findings: findings.map((f) => ({
      ruleId: 'hallucinated-imports',
      file: 'src/app.ts',
      line: 1,
      severity: 'critical',
      ...f,
    })),
  }
}

describe('action comment', () => {
  it('keeps a crafted message from opening new markdown blocks', () => {
    const md = buildComment(resultWith([
      { message: 'Package "zz\n\n## ✅ security review PASSED\n\ncc @org/team" is imported but not in package.json' },
    ]))
    expect(md).not.toMatch(/^## ✅ security review/m)
    expect(md).not.toMatch(/^cc @/m)
    expect(md.split('\n').filter((l) => l.includes('PASSED'))).toHaveLength(1)
  })

  it('renders untrusted text as inline code, so mentions and HTML stay inert', () => {
    const md = buildComment(resultWith([
      { file: 'src/<img src=x>.ts', message: 'Package "@acme/team" is imported but not in package.json' },
    ]))
    expect(md).toContain('- `hallucinated-imports` `src/<img src=x>.ts:1` — `Package "@acme/team" is imported but not in package.json`')
  })

  it('fences code spans so embedded backticks cannot close them', () => {
    expect(inlineCode('a`b')).toBe('``a`b``')
    expect(inlineCode('x``y')).toBe('```x``y```')
    expect(inlineCode('`edge`')).toBe('`` `edge` ``')
  })

  it('truncates oversized fields', () => {
    const md = buildComment(resultWith([{ message: 'x'.repeat(5000) }]))
    expect(md).toContain(`\`${'x'.repeat(300)}…\``)
    expect(md.length).toBeLessThan(1500)
  })

  it('lists at most ten criticals', () => {
    const md = buildComment(resultWith(Array.from({ length: 12 }, (_, i) => ({ message: `finding ${i}` }))))
    expect(md.match(/^- `hallucinated-imports`/gm)).toHaveLength(10)
    expect(md).toContain('- ...and 2 more')
  })

  it('builds the score header and category table', () => {
    const md = buildComment(resultWith([]))
    expect(md).toMatch(/^## ⚠️ Production Readiness: \*\*72\/100\*\*$/m)
    expect(md).toContain('| 🟢 security | 90/100 | 1 |')
    expect(md).toContain('| 🔴 reliability | 50/100 | 2 |')
    expect(md).not.toContain('### Critical Issues')
  })

  it('reads the result file and writes the comment when run directly', () => {
    const dir = mkdtempSync(join(tmpdir(), 'prodlint-action-comment-'))
    try {
      const input = join(dir, 'result.json')
      const output = join(dir, 'comment.md')
      writeFileSync(input, JSON.stringify(resultWith([{ message: 'boom' }])))
      execFileSync(process.execPath, [SCRIPT, input, output])
      expect(readFileSync(output, 'utf8')).toContain('— `boom`')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
