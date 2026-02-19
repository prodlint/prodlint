import { parse } from '@babel/parser'
import type { ParseResult } from '@babel/parser'
import type {
  File,
  Node,
  ForStatement,
  ForInStatement,
  ForOfStatement,
  WhileStatement,
  DoWhileStatement,
  CallExpression,
  TaggedTemplateExpression,
  ImportDeclaration,
  StringLiteral,
} from '@babel/types'

export type { ParseResult }

/**
 * Parse a JS/TS/JSX/TSX file into a Babel AST.
 * Returns null on parse failure (graceful fallback to regex).
 */
export function parseFile(content: string, fileName: string): ParseResult<File> | null {
  const plugins: any[] = ['decorators']

  if (/\.tsx?$/.test(fileName)) {
    plugins.push('typescript')
  }
  if (/\.[jt]sx$/.test(fileName)) {
    plugins.push('jsx')
  }
  // .js/.mjs/.cjs files may also use JSX (common in React projects)
  if (/\.(js|mjs|cjs)$/.test(fileName)) {
    plugins.push('jsx')
  }

  try {
    return parse(content, {
      sourceType: 'module',
      allowImportExportEverywhere: true,
      allowReturnOutsideFunction: true,
      plugins,
    })
  } catch {
    return null
  }
}

/**
 * Simple recursive AST visitor (depth-first).
 * Calls visitor(node, parent) for every node.
 */
export function walkAST(
  node: Node | null | undefined,
  visitor: (node: Node, parent: Node | null) => void,
  parent: Node | null = null,
): void {
  if (!node || typeof node !== 'object') return

  visitor(node, parent)

  for (const key of Object.keys(node)) {
    if (key === 'start' || key === 'end' || key === 'loc' || key === 'type') continue
    const val = (node as any)[key]
    if (Array.isArray(val)) {
      for (const item of val) {
        if (item && typeof item === 'object' && item.type) {
          walkAST(item, visitor, node)
        }
      }
    } else if (val && typeof val === 'object' && val.type) {
      walkAST(val, visitor, node)
    }
  }
}

/**
 * Check if a node is a tagged template expression with a known safe SQL tag.
 */
export function isTaggedTemplateSql(node: TaggedTemplateExpression): boolean {
  const tag = node.tag

  // sql`...`
  if (tag.type === 'Identifier' && tag.name === 'sql') return true

  // Prisma.sql`...`, db.sql`...`, db.query`...`
  if (tag.type === 'MemberExpression') {
    const prop = tag.property
    if (prop.type === 'Identifier' && (prop.name === 'sql' || prop.name === 'query' || prop.name === 'raw')) {
      return true
    }
  }

  return false
}

interface LoopRange {
  loopLine: number   // 0-indexed
  bodyStart: number  // 0-indexed
  bodyEnd: number    // 0-indexed
}

/**
 * Find loop body ranges using AST (accurate, no brace counting).
 * Returns for/while/do-while/forEach/map body locations (0-indexed lines).
 */
export function findLoopsAST(ast: ParseResult<File>): LoopRange[] {
  const loops: LoopRange[] = []

  walkAST(ast.program, (node) => {
    // for / for-in / for-of / while / do-while
    if (
      node.type === 'ForStatement' ||
      node.type === 'ForInStatement' ||
      node.type === 'ForOfStatement' ||
      node.type === 'WhileStatement' ||
      node.type === 'DoWhileStatement'
    ) {
      const loop = node as ForStatement | ForInStatement | ForOfStatement | WhileStatement | DoWhileStatement
      const body = loop.body
      if (body.loc && node.loc) {
        loops.push({
          loopLine: node.loc.start.line - 1,
          bodyStart: body.loc.start.line - 1,
          bodyEnd: body.loc.end.line - 1,
        })
      }
    }

    // .forEach() / .map() calls
    if (node.type === 'CallExpression') {
      const call = node as CallExpression
      if (
        call.callee.type === 'MemberExpression' &&
        call.callee.property.type === 'Identifier' &&
        (call.callee.property.name === 'forEach' || call.callee.property.name === 'map')
      ) {
        const callback = call.arguments[0]
        if (callback && callback.loc && node.loc) {
          loops.push({
            loopLine: node.loc.start.line - 1,
            bodyStart: callback.loc.start.line - 1,
            bodyEnd: callback.loc.end.line - 1,
          })
        }
      }
    }
  })

  return loops
}

/**
 * Extract all import/require sources from AST.
 */
export function getImportSources(ast: ParseResult<File>): string[] {
  const sources: string[] = []

  walkAST(ast.program, (node) => {
    // import ... from 'x'
    if (node.type === 'ImportDeclaration') {
      sources.push((node as ImportDeclaration).source.value)
    }

    // const x = require('y')
    if (node.type === 'CallExpression') {
      const call = node as CallExpression
      if (
        call.callee.type === 'Identifier' &&
        call.callee.name === 'require' &&
        call.arguments.length === 1 &&
        call.arguments[0].type === 'StringLiteral'
      ) {
        sources.push((call.arguments[0] as StringLiteral).value)
      }
    }
  })

  return sources
}

