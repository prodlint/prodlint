import { describe, it, expect } from 'vitest'
import { isFrameworkSafeMethod, DEPENDENCY_TO_FRAMEWORK, SQL_SAFE_ORMS, RATE_LIMIT_FRAMEWORKS } from '../../src/utils/frameworks.js'
import { scanFiles } from '../helpers.js'

describe('isFrameworkSafeMethod', () => {
  it('returns true for .contains() with Prisma', () => {
    expect(isFrameworkSafeMethod('contains', new Set(['prisma']))).toBe(true)
  })

  it('returns true for .contains() with Supabase', () => {
    expect(isFrameworkSafeMethod('contains', new Set(['supabase']))).toBe(true)
  })

  it('returns true for .flatten() with lodash', () => {
    expect(isFrameworkSafeMethod('flatten', new Set(['lodash']))).toBe(true)
  })

  it('returns true for .startsWith() with Prisma', () => {
    expect(isFrameworkSafeMethod('startsWith', new Set(['prisma']))).toBe(true)
  })

  it('returns false for .substr() with Prisma', () => {
    expect(isFrameworkSafeMethod('substr', new Set(['prisma']))).toBe(false)
  })

  it('returns false for unknown framework', () => {
    expect(isFrameworkSafeMethod('contains', new Set(['unknown']))).toBe(false)
  })

  it('returns false with no frameworks', () => {
    expect(isFrameworkSafeMethod('contains', new Set())).toBe(false)
  })

  it('checks multiple frameworks', () => {
    expect(isFrameworkSafeMethod('flatten', new Set(['prisma', 'lodash']))).toBe(true)
  })

  // obsidian.d.ts declares contains() on Array<T> and String, and none of the other
  // methods hallucinated-api reports
  it('returns true for .contains() with Obsidian, and for no other method the rule reports', () => {
    const obsidian = new Set(['obsidian'])
    expect(isFrameworkSafeMethod('contains', obsidian)).toBe(true)
    for (const method of ['flatten', 'substr', 'trimLeft', 'trimRight', 'isArray', 'hasOwnProperty', 'json', 'abort']) {
      expect(isFrameworkSafeMethod(method, obsidian), method).toBe(false)
    }
  })
})

describe('DEPENDENCY_TO_FRAMEWORK', () => {
  it('maps @prisma/client to prisma', () => {
    expect(DEPENDENCY_TO_FRAMEWORK['@prisma/client']).toBe('prisma')
  })

  it('maps @supabase/supabase-js to supabase', () => {
    expect(DEPENDENCY_TO_FRAMEWORK['@supabase/supabase-js']).toBe('supabase')
  })

  it('maps drizzle-orm to drizzle', () => {
    expect(DEPENDENCY_TO_FRAMEWORK['drizzle-orm']).toBe('drizzle')
  })

  it('maps lodash-es to lodash', () => {
    expect(DEPENDENCY_TO_FRAMEWORK['lodash-es']).toBe('lodash')
  })

  it('maps @upstash/ratelimit', () => {
    expect(DEPENDENCY_TO_FRAMEWORK['@upstash/ratelimit']).toBe('upstash-ratelimit')
  })

  it('maps obsidian', () => {
    expect(DEPENDENCY_TO_FRAMEWORK['obsidian']).toBe('obsidian')
  })
})

// Through the scanner: a package.json that lists obsidian makes its files an Obsidian
// plugin's, where arrays and strings do have contains()
describe('an Obsidian plugin', () => {
  const plugin = [
    "import { Plugin, TFile } from 'obsidian'",
    '',
    "const NOTES = ['md', 'canvas']",
    "const DRAFT = 'draft'",
    '',
    'export default class Notes extends Plugin {',
    '  isNote(file: TFile): boolean {',
    '    return NOTES.contains(file.extension)',
    '  }',
    '',
    '  isDraft(file: TFile): boolean {',
    '    return file.basename.toLowerCase().contains(DRAFT)',
    '  }',
    '}',
    '',
  ].join('\n')

  /** What hallucinated-api reports in main.ts: each line, with the method it's about */
  async function reported(packageJson: Record<string, unknown>, code = plugin): Promise<string[]> {
    const result = await scanFiles({ 'package.json': JSON.stringify(packageJson), 'main.ts': code })
    return result.findings
      .filter(f => f.ruleId === 'hallucinated-api')
      .map(f => `${f.file}:${f.line} ${/instead of (?:deprecated )?(\.\w+\(\))/.exec(f.message)?.[1]}`)
  }

  it("isn't told to replace .contains() when its package.json lists obsidian", async () => {
    // Most plugins list it in devDependencies; some as a dependency or a peer
    for (const field of ['dependencies', 'devDependencies', 'peerDependencies']) {
      expect(await reported({ name: 'notes', [field]: { obsidian: 'latest' } }), field).toEqual([])
    }
  })

  it('is told to, like any project, when it does not', async () => {
    const lines = ['main.ts:8 .contains()', 'main.ts:12 .contains()']
    expect(await reported({ name: 'notes', devDependencies: { typescript: '^5.0.0' } })).toEqual(lines)
    // A name or a keyword doesn't make a package a plugin
    expect(await reported({ name: 'obsidian-notes', keywords: ['obsidian'] })).toEqual(lines)
  })

  it('is still told about the methods Obsidian does not add', async () => {
    const code = [
      "const GROUPS = [['md'], ['canvas']]",
      "const DRAFT = 'draft'",
      '',
      'export const all = GROUPS.flatten()',
      'export const short = DRAFT.substr(0, 2)',
      'export const isDraft = (name: string) => name.trimLeft().contains(DRAFT)',
      '',
    ].join('\n')

    expect(await reported({ name: 'notes', devDependencies: { obsidian: 'latest' } }, code))
      .toEqual(['main.ts:4 .flatten()', 'main.ts:5 .substr()', 'main.ts:6 .trimLeft()'])
  })
})

describe('SQL_SAFE_ORMS', () => {
  it('includes prisma', () => {
    expect(SQL_SAFE_ORMS.has('prisma')).toBe(true)
  })

  it('includes drizzle', () => {
    expect(SQL_SAFE_ORMS.has('drizzle')).toBe(true)
  })

  it('does not include express', () => {
    expect(SQL_SAFE_ORMS.has('express')).toBe(false)
  })
})

describe('RATE_LIMIT_FRAMEWORKS', () => {
  it('includes upstash-ratelimit', () => {
    expect(RATE_LIMIT_FRAMEWORKS.has('upstash-ratelimit')).toBe(true)
  })

  it('includes express-rate-limit', () => {
    expect(RATE_LIMIT_FRAMEWORKS.has('express-rate-limit')).toBe(true)
  })
})
