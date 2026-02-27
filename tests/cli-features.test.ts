import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execSync } from 'node:child_process'
import { writeFileSync, unlinkSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const CLI_PATH = join(__dirname, '..', 'dist', 'cli.js')

function run(args: string, cwd?: string): { stdout: string; status: number } {
  try {
    const stdout = execSync(`node ${CLI_PATH} ${args}`, {
      cwd: cwd ?? join(__dirname, '..'),
      encoding: 'utf8',
      timeout: 30000,
    })
    return { stdout, status: 0 }
  } catch (err: unknown) {
    const e = err as { stdout?: string; status?: number }
    return { stdout: e.stdout ?? '', status: e.status ?? 1 }
  }
}

describe('--summary flag', () => {
  it('outputs PASS for clean project', () => {
    // Create a tiny clean project
    const dir = join(tmpdir(), `prodlint-test-summary-${Date.now()}`)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'clean.ts'), 'export const x = 1\n')

    const { stdout } = run(`${dir} --summary`)
    expect(stdout).toContain('PASS')

    rmSync(dir, { recursive: true, force: true })
  })

  it('outputs FAIL when critical findings exist', () => {
    const dir = join(tmpdir(), `prodlint-test-summary-fail-${Date.now()}`)
    mkdirSync(dir, { recursive: true })
    // This will trigger env-fallback-secret (critical)
    writeFileSync(join(dir, 'config.ts'), `
const key = process.env.API_SECRET || "sk_live_hardcoded123"
export default key
`)

    const { stdout, status } = run(`${dir} --summary`)
    expect(stdout).toContain('FAIL')
    expect(status).toBe(1)

    rmSync(dir, { recursive: true, force: true })
  })
})

describe('--sarif flag', () => {
  it('outputs valid SARIF JSON', () => {
    const dir = join(tmpdir(), `prodlint-test-sarif-${Date.now()}`)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'clean.ts'), 'export const x = 1\n')

    const { stdout } = run(`${dir} --sarif`)
    const sarif = JSON.parse(stdout)
    expect(sarif.version).toBe('2.1.0')
    expect(sarif.$schema).toBe('https://json.schemastore.org/sarif-2.1.0.json')
    expect(sarif.runs).toHaveLength(1)
    expect(sarif.runs[0].tool.driver.name).toBe('prodlint')

    rmSync(dir, { recursive: true, force: true })
  })
})

describe('--profile flag', () => {
  it('startup profile only shows criticals', () => {
    const dir = join(tmpdir(), `prodlint-test-profile-${Date.now()}`)
    mkdirSync(dir, { recursive: true })
    // This triggers both critical (env-fallback-secret) and info (rate-limiting) findings
    writeFileSync(join(dir, 'route.ts'), `
export async function POST(req: Request) {
  const key = process.env.SECRET || "hardcoded123"
  return Response.json({ ok: true })
}
`)
    writeFileSync(join(dir, 'package.json'), '{"name":"test","dependencies":{}}')

    const { stdout } = run(`${dir} --profile startup --json`)
    const result = JSON.parse(stdout)
    // startup = only criticals
    for (const f of result.findings) {
      expect(f.severity).toBe('critical')
    }

    rmSync(dir, { recursive: true, force: true })
  })
})

describe('--baseline flags', () => {
  it('saves and loads baseline, filtering known findings', () => {
    const dir = join(tmpdir(), `prodlint-test-baseline-${Date.now()}`)
    mkdirSync(dir, { recursive: true })
    const baselinePath = join(dir, '.prodlint-baseline.json')

    // Create a file with a known issue
    writeFileSync(join(dir, 'config.ts'), `
const secret = process.env.DB_URL || "postgres://localhost/test"
export default secret
`)

    // Save baseline
    const { stdout: saveOut } = run(`${dir} --baseline-save ${baselinePath}`)
    expect(saveOut).toContain('Baseline saved')
    expect(existsSync(baselinePath)).toBe(true)

    // Run with baseline — same code should have 0 new findings
    const { stdout: checkOut } = run(`${dir} --baseline ${baselinePath} --json`)
    const result = JSON.parse(checkOut)
    expect(result.findings).toHaveLength(0)

    rmSync(dir, { recursive: true, force: true })
  })

  it('shows new findings not in baseline', () => {
    const dir = join(tmpdir(), `prodlint-test-baseline-new-${Date.now()}`)
    mkdirSync(dir, { recursive: true })
    const baselinePath = join(dir, '.prodlint-baseline.json')

    // Create initial file and save baseline
    writeFileSync(join(dir, 'config.ts'), `export const x = 1\n`)
    run(`${dir} --baseline-save ${baselinePath}`)

    // Now add a problematic file
    writeFileSync(join(dir, 'bad.ts'), `
const key = process.env.API_KEY || "sk_live_test123"
export default key
`)

    // Run with baseline — should show only the new finding
    const { stdout } = run(`${dir} --baseline ${baselinePath} --json`)
    const result = JSON.parse(stdout)
    expect(result.findings.length).toBeGreaterThan(0)
    // All findings should be from the new file
    for (const f of result.findings) {
      expect(f.file).toContain('bad.ts')
    }

    rmSync(dir, { recursive: true, force: true })
  })
})

describe('--help flag', () => {
  it('shows all new flags', () => {
    const { stdout } = run('--help')
    expect(stdout).toContain('--sarif')
    expect(stdout).toContain('--summary')
    expect(stdout).toContain('--profile')
    expect(stdout).toContain('--baseline')
    expect(stdout).toContain('--baseline-save')
  })
})
