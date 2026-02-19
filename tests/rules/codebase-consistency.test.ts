import { describe, it, expect } from 'vitest'
import { codebaseConsistencyRule } from '../../src/rules/codebase-consistency.js'
import { makeFile, makeProject } from '../helpers.js'

const project = makeProject()

describe('codebase-consistency rule', () => {
  it('flags mixed import styles', () => {
    const files = [
      makeFile(`import express from 'express'\nconst x = 1`, { relativePath: 'src/a.ts' }),
      makeFile(`import cors from 'cors'\nconst y = 2`, { relativePath: 'src/b.ts' }),
      makeFile(`const fs = require('fs')\nconst z = 3`, { relativePath: 'src/c.ts' }),
      makeFile(`const path = require('path')\nconst w = 4`, { relativePath: 'src/d.ts' }),
    ]
    const findings = codebaseConsistencyRule.checkProject!(files, project)
    expect(findings.some(f => f.message.includes('Import style'))).toBe(true)
  })

  it('allows consistent import style', () => {
    const files = [
      makeFile(`import express from 'express'`, { relativePath: 'src/a.ts' }),
      makeFile(`import cors from 'cors'`, { relativePath: 'src/b.ts' }),
      makeFile(`import path from 'path'`, { relativePath: 'src/c.ts' }),
    ]
    const findings = codebaseConsistencyRule.checkProject!(files, project)
    expect(findings.some(f => f.message.includes('Import style'))).toBe(false)
  })

  it('flags mixed quote styles in imports', () => {
    const files = [
      makeFile(`import a from 'a'`, { relativePath: 'src/a.ts' }),
      makeFile(`import b from "b"`, { relativePath: 'src/b.ts' }),
      makeFile(`import c from "c"`, { relativePath: 'src/c.ts' }),
    ]
    const findings = codebaseConsistencyRule.checkProject!(files, project)
    expect(findings.some(f => f.message.includes('Quote style'))).toBe(true)
  })

  it('returns empty for fewer than 3 source files', () => {
    const files = [
      makeFile(`import a from 'a'`, { relativePath: 'src/a.ts' }),
      makeFile(`const b = require('b')`, { relativePath: 'src/b.ts' }),
    ]
    const findings = codebaseConsistencyRule.checkProject!(files, project)
    expect(findings).toHaveLength(0)
  })

  it('skips test and config files', () => {
    const files = [
      makeFile(`import a from 'a'`, { relativePath: 'src/a.ts' }),
      makeFile(`import b from 'b'`, { relativePath: 'src/b.ts' }),
      makeFile(`import c from 'c'`, { relativePath: 'src/c.ts' }),
      makeFile(`const d = require('d')`, { relativePath: 'tests/d.test.ts' }),
      makeFile(`const e = require('e')`, { relativePath: 'jest.config.ts' }),
    ]
    const findings = codebaseConsistencyRule.checkProject!(files, project)
    // Test/config files excluded, only 3 consistent ESM files remain
    expect(findings.some(f => f.message.includes('Import style'))).toBe(false)
  })

  it('uses warning severity for very low consistency', () => {
    const files = [
      makeFile(`import a from 'a'`, { relativePath: 'src/a.ts' }),
      makeFile(`import b from "b"`, { relativePath: 'src/b.ts' }),
      makeFile(`import c from "c"`, { relativePath: 'src/c.ts' }),
      makeFile(`import d from "d"`, { relativePath: 'src/d.ts' }),
      makeFile(`import e from "e"`, { relativePath: 'src/e.ts' }),
    ]
    const findings = codebaseConsistencyRule.checkProject!(files, project)
    const quoteFindings = findings.filter(f => f.message.includes('Quote style'))
    // 1 single, 4 double = 80% consistent = below 90% threshold
    expect(quoteFindings.length).toBeGreaterThan(0)
  })

  it('flags mixed camelCase and snake_case naming', () => {
    const files = [
      makeFile('export function getUserData() {}', { relativePath: 'src/a.ts' }),
      makeFile('export function fetchItems() {}', { relativePath: 'src/b.ts' }),
      makeFile('export const get_user_data = () => {}', { relativePath: 'src/c.ts' }),
      makeFile('export const fetch_items = () => {}', { relativePath: 'src/d.ts' }),
    ]
    const findings = codebaseConsistencyRule.checkProject!(files, project)
    expect(findings.some(f => f.message.includes('Naming'))).toBe(true)
  })

  it('allows consistent camelCase naming', () => {
    const files = [
      makeFile('export function getUserData() {}', { relativePath: 'src/a.ts' }),
      makeFile('export function fetchItems() {}', { relativePath: 'src/b.ts' }),
      makeFile('export function processOrder() {}', { relativePath: 'src/c.ts' }),
    ]
    const findings = codebaseConsistencyRule.checkProject!(files, project)
    expect(findings.some(f => f.message.includes('Naming'))).toBe(false)
  })

  it('flags mixed HTTP clients', () => {
    const files = [
      makeFile(`import axios from 'axios'\naxios.get('/api')`, { relativePath: 'src/a.ts' }),
      makeFile(`fetch('/api/data')`, { relativePath: 'src/b.ts' }),
      makeFile(`fetch('/api/users')`, { relativePath: 'src/c.ts' }),
      makeFile(`import axios from 'axios'\naxios.post('/api')`, { relativePath: 'src/d.ts' }),
    ]
    const findings = codebaseConsistencyRule.checkProject!(files, project)
    expect(findings.some(f => f.message.includes('HTTP client'))).toBe(true)
  })
})
