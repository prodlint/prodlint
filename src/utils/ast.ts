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
  MemberExpression,
  TemplateLiteral,
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

/**
 * Check if a node represents user input (request params, search params, form data).
 * Matches: req.query.x, req.body.x, req.params.x, searchParams.get(),
 *          formData.get(), request.nextUrl.searchParams.get()
 */
export function isUserInputNode(node: Node): boolean {
  // req.query.x, req.body.x, req.params.x, request.query.x, etc.
  if (node.type === 'MemberExpression') {
    const mem = node as MemberExpression
    if (mem.object.type === 'MemberExpression') {
      const inner = mem.object as MemberExpression
      if (inner.object.type === 'Identifier') {
        const objName = inner.object.name
        if (objName === 'req' || objName === 'request') {
          if (inner.property.type === 'Identifier') {
            const prop = inner.property.name
            if (prop === 'query' || prop === 'body' || prop === 'params') return true
          }
        }
      }
    }
  }

  // searchParams.get(), formData.get()
  if (node.type === 'CallExpression') {
    const call = node as CallExpression
    if (call.callee.type === 'MemberExpression') {
      const callee = call.callee as MemberExpression
      if (callee.property.type === 'Identifier' && callee.property.name === 'get') {
        // searchParams.get()
        if (callee.object.type === 'Identifier') {
          const name = callee.object.name
          if (name === 'searchParams' || name === 'formData') return true
        }
        // request.nextUrl.searchParams.get()
        if (callee.object.type === 'MemberExpression') {
          const inner = callee.object as MemberExpression
          if (inner.property.type === 'Identifier' && inner.property.name === 'searchParams') {
            return true
          }
        }
      }
    }
  }

  return false
}

/**
 * Check if a node is a static string (StringLiteral or TemplateLiteral with 0 expressions).
 */
export function isStaticString(node: Node): boolean {
  if (node.type === 'StringLiteral') return true
  if (node.type === 'TemplateLiteral') {
    return (node as TemplateLiteral).expressions.length === 0
  }
  return false
}

/**
 * Find useEffect callback body line ranges (0-indexed).
 * Returns array of {start, end} for each useEffect's callback body.
 */
export function findUseEffectRanges(ast: ParseResult<File>): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = []

  walkAST(ast.program, (node) => {
    if (node.type !== 'CallExpression') return
    const call = node as CallExpression
    if (call.callee.type !== 'Identifier' || call.callee.name !== 'useEffect') return
    const callback = call.arguments[0]
    if (!callback || !callback.loc) return
    ranges.push({
      start: callback.loc.start.line - 1,
      end: callback.loc.end.line - 1,
    })
  })

  return ranges
}

/**
 * Check if any node in a subtree matches a predicate.
 */
export function subtreeContains(node: Node, predicate: (n: Node) => boolean): boolean {
  if (predicate(node)) return true
  for (const key of Object.keys(node)) {
    if (key === 'start' || key === 'end' || key === 'loc' || key === 'type') continue
    const val = (node as any)[key]
    if (Array.isArray(val)) {
      for (const item of val) {
        if (item && typeof item === 'object' && item.type) {
          if (subtreeContains(item, predicate)) return true
        }
      }
    } else if (val && typeof val === 'object' && val.type) {
      if (subtreeContains(val, predicate)) return true
    }
  }
  return false
}

