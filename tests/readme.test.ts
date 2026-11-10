import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { scan } from '../src/scanner.js'
import { reportPretty } from '../src/reporter.js'
import { rules } from '../src/rules/index.js'
import type { Category } from '../src/types.js'

// The README is the first thing a person or an agent reads, so what it shows as prodlint's
// output has to be prodlint's output, and its rule tables have to list the rules there are.

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const README = readFileSync(join(ROOT, 'README.md'), 'utf8').replace(/\r\n/g, '\n')
const DEMO = 'tests/fixtures/readme-demo'

const stripColors = (text: string) => text.replace(/\x1b\[[0-9;]*m/g, '')

describe('README', () => {
  it(`shows what prodlint prints for ${DEMO}`, async () => {
    const result = await scan({ path: join(ROOT, DEMO) })
    // Run from source there's no built-in version, so take the one the build would stamp
    const { version } = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
    const printed = stripColors(reportPretty({ ...result, version })).replace(/^\n+/, '').trimEnd()

    // The first fenced block that starts with the version line. sync-versions.cjs keeps that
    // line's number in step with package.json.
    const shown = /```\n( *prodlint v\d+\.\d+\.\d+\n[\s\S]*?)\n```/.exec(README)
    expect(shown, 'README.md has no sample output block').not.toBeNull()
    expect(
      shown![1].trimEnd(),
      `README.md's sample output is out of date. Replace it with the output of: node dist/cli.js ${DEMO}`,
    ).toBe(printed)
  })

  it('lists every rule once, under its category, with the right counts', () => {
    const headings: Record<Category, string> = {
      security: 'Security',
      reliability: 'Reliability',
      performance: 'Performance',
      'ai-quality': 'AI Quality',
    }

    expect(README).toContain(`## ${rules.length} Rules across ${Object.keys(headings).length} Categories`)

    for (const [category, heading] of Object.entries(headings) as [Category, string][]) {
      const expected = rules.filter(r => r.category === category).map(r => r.id)
      // From "### Security (27 rules)" to the next heading
      const section = new RegExp(`^### ${heading} \\((\\d+) rules\\)\\n([\\s\\S]*?)(?=^##)`, 'm').exec(README)
      expect(section, `README.md has no "### ${heading} (N rules)" section`).not.toBeNull()
      const listed = [...section![2].matchAll(/^\| `([a-z0-9-]+)` \|/gm)].map(m => m[1])

      expect(Number(section![1]), `${heading}: the count in the heading`).toBe(expected.length)
      expect(listed, `${heading}: the rules in the table, in registry order`).toEqual(expected)
    }
  })
})
