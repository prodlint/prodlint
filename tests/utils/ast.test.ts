import { describe, it, expect } from 'vitest'
import { parseFile, walkAST, findLoopsAST, getImportSources, isTaggedTemplateSql } from '../../src/utils/ast.js'
import type { TaggedTemplateExpression } from '@babel/types'

describe('parseFile', () => {
  it('parses TypeScript file', () => {
    const ast = parseFile(`const x: number = 42`, 'test.ts')
    expect(ast).not.toBeNull()
    expect(ast!.program.body).toHaveLength(1)
  })

  it('parses TSX file', () => {
    const ast = parseFile(`const el = <div>Hello</div>`, 'test.tsx')
    expect(ast).not.toBeNull()
  })

  it('parses JSX file', () => {
    const ast = parseFile(`const el = <div>Hello</div>`, 'test.jsx')
    expect(ast).not.toBeNull()
  })

  it('returns null for invalid syntax', () => {
    const ast = parseFile(`const x = {{{`, 'test.ts')
    expect(ast).toBeNull()
  })

  it('handles decorators', () => {
    const ast = parseFile(`@injectable()\nclass MyService {}`, 'test.ts')
    expect(ast).not.toBeNull()
  })
})

describe('findLoopsAST', () => {
  it('finds for loops', () => {
    const ast = parseFile([
      'for (let i = 0; i < 10; i++) {',
      '  console.log(i)',
      '}',
    ].join('\n'), 'test.ts')!
    const loops = findLoopsAST(ast)
    expect(loops).toHaveLength(1)
    expect(loops[0].loopLine).toBe(0)
  })

  it('finds for-of loops', () => {
    const ast = parseFile([
      'for (const item of items) {',
      '  process(item)',
      '}',
    ].join('\n'), 'test.ts')!
    const loops = findLoopsAST(ast)
    expect(loops).toHaveLength(1)
  })

  it('finds while loops', () => {
    const ast = parseFile([
      'while (true) {',
      '  break',
      '}',
    ].join('\n'), 'test.ts')!
    const loops = findLoopsAST(ast)
    expect(loops).toHaveLength(1)
  })

  it('finds .forEach calls', () => {
    const ast = parseFile([
      'items.forEach((item) => {',
      '  process(item)',
      '})',
    ].join('\n'), 'test.ts')!
    const loops = findLoopsAST(ast)
    expect(loops).toHaveLength(1)
  })

  it('finds .map calls', () => {
    const ast = parseFile([
      'const mapped = items.map((item) => {',
      '  return item.name',
      '})',
    ].join('\n'), 'test.ts')!
    const loops = findLoopsAST(ast)
    expect(loops).toHaveLength(1)
  })

  it('returns empty for no loops', () => {
    const ast = parseFile(`const x = 42`, 'test.ts')!
    const loops = findLoopsAST(ast)
    expect(loops).toHaveLength(0)
  })
})

describe('getImportSources', () => {
  it('extracts import sources', () => {
    const ast = parseFile([
      `import { foo } from 'bar'`,
      `import React from 'react'`,
    ].join('\n'), 'test.ts')!
    const sources = getImportSources(ast)
    expect(sources).toContain('bar')
    expect(sources).toContain('react')
  })

  it('extracts require sources', () => {
    const ast = parseFile([
      `const fs = require('fs')`,
      `const path = require('path')`,
    ].join('\n'), 'test.js')!
    const sources = getImportSources(ast)
    expect(sources).toContain('fs')
    expect(sources).toContain('path')
  })
})

describe('isTaggedTemplateSql', () => {
  it('detects sql`` tag', () => {
    const ast = parseFile('const result = sql`SELECT * FROM users`', 'test.ts')!
    let found = false
    walkAST(ast.program, (node) => {
      if (node.type === 'TaggedTemplateExpression') {
        found = isTaggedTemplateSql(node as TaggedTemplateExpression)
      }
    })
    expect(found).toBe(true)
  })

  it('detects Prisma.sql`` tag', () => {
    const ast = parseFile('const result = Prisma.sql`SELECT * FROM users`', 'test.ts')!
    let found = false
    walkAST(ast.program, (node) => {
      if (node.type === 'TaggedTemplateExpression') {
        found = isTaggedTemplateSql(node as TaggedTemplateExpression)
      }
    })
    expect(found).toBe(true)
  })

  it('rejects non-sql tags', () => {
    const ast = parseFile('const result = html`<div>hello</div>`', 'test.ts')!
    let found = false
    walkAST(ast.program, (node) => {
      if (node.type === 'TaggedTemplateExpression') {
        found = isTaggedTemplateSql(node as TaggedTemplateExpression)
      }
    })
    expect(found).toBe(false)
  })
})
