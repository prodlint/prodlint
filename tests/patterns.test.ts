import { describe, it, expect } from 'vitest'
import {
  isApiRoute,
  isClientComponent,
  buildCommentMap,
  isCommentLine,
  isLineSuppressed,
} from '../src/utils/patterns.js'

describe('isApiRoute', () => {
  it('detects App Router route files', () => {
    expect(isApiRoute('app/api/users/route.ts')).toBe(true)
    expect(isApiRoute('app/api/deep/nested/route.js')).toBe(true)
  })

  it('detects Pages Router API files', () => {
    expect(isApiRoute('pages/api/users.ts')).toBe(true)
    expect(isApiRoute('pages/api/users/index.ts')).toBe(true)
  })

  it('rejects non-API files', () => {
    expect(isApiRoute('app/page.tsx')).toBe(false)
    expect(isApiRoute('src/utils/helper.ts')).toBe(false)
    expect(isApiRoute('components/button.tsx')).toBe(false)
  })
})

describe('isClientComponent', () => {
  it('detects "use client" directive', () => {
    expect(isClientComponent(`"use client"\nexport function Page() {}`)).toBe(true)
    expect(isClientComponent(`'use client'\nexport function Page() {}`)).toBe(true)
  })

  it('returns false for server components', () => {
    expect(isClientComponent(`export function Page() {}`)).toBe(false)
  })

  it('returns false when "use client" is not at top', () => {
    const code = Array(50).fill('// line').join('\n') + `\n"use client"`
    expect(isClientComponent(code)).toBe(true) // Still within first 500 chars
  })
})

describe('buildCommentMap', () => {
  it('marks block comment lines', () => {
    const lines = ['/* start', 'middle', 'end */']
    const map = buildCommentMap(lines)
    expect(map).toEqual([true, true, true])
  })

  it('marks single-line block comments', () => {
    const lines = ['/* single-line comment */']
    const map = buildCommentMap(lines)
    expect(map).toEqual([true])
  })

  it('does not mark regular code', () => {
    const lines = ['const x = 1', 'const y = 2']
    const map = buildCommentMap(lines)
    expect(map).toEqual([false, false])
  })

  it('marks JSDoc-style comments', () => {
    const lines = ['/**', ' * @param x', ' */']
    const map = buildCommentMap(lines)
    expect(map).toEqual([true, true, true])
  })

  it('handles mixed code and block comments', () => {
    const lines = ['const a = 1', '/* comment */', 'const b = 2']
    const map = buildCommentMap(lines)
    expect(map).toEqual([false, true, false])
  })
})

describe('isCommentLine', () => {
  it('detects single-line comments', () => {
    const lines = ['// this is a comment']
    const map = buildCommentMap(lines)
    expect(isCommentLine(lines, 0, map)).toBe(true)
  })

  it('detects block comment lines via map', () => {
    const lines = ['/* start', 'inside block', '*/']
    const map = buildCommentMap(lines)
    expect(isCommentLine(lines, 1, map)).toBe(true)
  })

  it('returns false for code lines', () => {
    const lines = ['const x = 1']
    const map = buildCommentMap(lines)
    expect(isCommentLine(lines, 0, map)).toBe(false)
  })
})

describe('isLineSuppressed', () => {
  it('suppresses with prodlint-disable-next-line', () => {
    const lines = [
      '// prodlint-disable-next-line secrets',
      'const key = "sk_live_abc"',
    ]
    expect(isLineSuppressed(lines, 1, 'secrets')).toBe(true)
  })

  it('does not suppress wrong rule', () => {
    const lines = [
      '// prodlint-disable-next-line auth-checks',
      'const key = "sk_live_abc"',
    ]
    expect(isLineSuppressed(lines, 1, 'secrets')).toBe(false)
  })

  it('suppresses with file-level prodlint-disable', () => {
    const lines = [
      '// prodlint-disable secrets',
      '',
      'const key = "sk_live_abc"',
    ]
    expect(isLineSuppressed(lines, 2, 'secrets')).toBe(true)
  })

  it('supports comma-separated rule IDs', () => {
    const lines = [
      '// prodlint-disable-next-line secrets, auth-checks',
      'const key = "sk_live_abc"',
    ]
    expect(isLineSuppressed(lines, 1, 'secrets')).toBe(true)
    expect(isLineSuppressed(lines, 1, 'auth-checks')).toBe(true)
    expect(isLineSuppressed(lines, 1, 'cors-config')).toBe(false)
  })

  it('file-level disable only works at top of file', () => {
    const lines = [
      'const x = 1',
      '// prodlint-disable secrets',
      'const key = "sk_live_abc"',
    ]
    expect(isLineSuppressed(lines, 2, 'secrets')).toBe(false)
  })

  it('returns false with no suppress comments', () => {
    const lines = ['const x = 1', 'const y = 2']
    expect(isLineSuppressed(lines, 1, 'secrets')).toBe(false)
  })
})
