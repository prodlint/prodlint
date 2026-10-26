import type { Rule, Finding, FileContext, ProjectContext } from '../types.js'
import { isTestFile, blankOut, closingBrace } from '../utils/patterns.js'
import { walkAST, subtreeContains } from '../utils/ast.js'
import type { Node, CatchClause } from '@babel/types'

// Next's helpers for letting its redirect error through a catch block
const RETHROW_HELPERS = /^(?:unstable_rethrow|isRedirectError|isNextRouterError)$/

/**
 * Does the catch block let a redirect through? Next's `unstable_rethrow(e)`, an
 * `isRedirectError(e)` or `NEXT_REDIRECT` check (the fix this rule suggests), or an
 * unconditional `throw e`.
 */
function rethrowsRedirect(handler: CatchClause): boolean {
  const param = handler.param?.type === 'Identifier' ? handler.param.name : undefined
  if (param && handler.body.body.some(statement => statement.type === 'ThrowStatement' &&
      statement.argument.type === 'Identifier' && statement.argument.name === param)) {
    return true
  }
  return subtreeContains(handler.body, (n: Node) =>
    (n.type === 'CallExpression' && n.callee.type === 'Identifier' && RETHROW_HELPERS.test(n.callee.name)) ||
    (n.type === 'StringLiteral' && n.value.includes('NEXT_REDIRECT')))
}

/** The regex fallback's version, on the catch body with comments blanked out; any `throw e` counts */
function bodyRethrowsRedirect(body: string, param: string | undefined): boolean {
  if (/\b(?:unstable_rethrow|isRedirectError|isNextRouterError)\s*\(|NEXT_REDIRECT/.test(body)) return true
  return param !== undefined && new RegExp(`\\bthrow\\s+${param.replace(/\$/g, '\\$')}(?![\\w$])`).test(body)
}

function redirectFinding(file: FileContext, line: number, column: number): Finding {
  return {
    ruleId: 'redirect-in-try-catch',
    file: file.relativePath,
    line,
    column,
    message: 'redirect() inside try/catch — Next.js redirect throws internally, the catch block will intercept it',
    severity: 'critical',
    category: 'reliability',
    fix: 'Move redirect() outside the try/catch block, or re-throw redirect errors in the catch: if (e instanceof Error && e.message === "NEXT_REDIRECT") throw e',
  }
}

export const redirectInTryCatchRule: Rule = {
  id: 'redirect-in-try-catch',
  name: 'Redirect Inside Try/Catch',
  description: 'Detects Next.js redirect() inside try/catch blocks — redirect throws internally and the catch swallows it',
  category: 'reliability',
  severity: 'critical',
  fileExtensions: ['ts', 'tsx', 'js', 'jsx'],

  check(file: FileContext, _project: ProjectContext): Finding[] {
    if (isTestFile(file.relativePath)) return []
    if (!/redirect\s*\(/.test(file.content)) return []

    const findings: Finding[] = []
    // A redirect inside nested try blocks is found from each of them
    const seen = new Set<number>()

    // AST path: redirect() calls in the block of a try that has a catch. A redirect in the
    // catch block propagates (unless an outer try's block holds it), and so does one
    // in a try/finally. Only Next's bare redirect() throws: res.redirect(),
    // NextResponse.redirect() and Response.redirect() return.
    if (file.ast) {
      try {
        walkAST(file.ast.program, (node: Node) => {
          if (node.type !== 'TryStatement' || !node.handler || rethrowsRedirect(node.handler)) return
          walkAST(node.block, (n: Node) => {
            if (n.type !== 'CallExpression' || n.callee.type !== 'Identifier' || n.callee.name !== 'redirect') return
            if (!n.loc || n.start == null || seen.has(n.start)) return
            seen.add(n.start)
            findings.push(redirectFinding(file, n.loc.start.line, n.loc.start.column + 1))
          })
        })
        return findings
      } catch {
        // AST walk failed, fall through to regex
        findings.length = 0
        seen.clear()
      }
    }

    // Regex fallback, on the source with comments and strings blanked out, so braces and
    // calls inside them don't count
    const source = file.lines.join('\n')
    const code = blankOut(source, true)
    const noComments = blankOut(source, false)
    for (const tryMatch of code.matchAll(/(?<![\w$.])try\s*\{/g)) {
      const open = tryMatch.index + tryMatch[0].length - 1
      const close = closingBrace(code, open)
      if (close === -1) continue

      const catchMatch = /^\s*catch\s*(?:\(\s*([A-Za-z_$][\w$]*)?[^)]*\)\s*)?\{/.exec(code.slice(close + 1))
      if (!catchMatch) continue // try/finally catches nothing
      const catchOpen = close + 1 + catchMatch[0].length - 1
      const catchClose = closingBrace(code, catchOpen)
      if (bodyRethrowsRedirect(noComments.slice(catchOpen + 1, catchClose === -1 ? code.length : catchClose), catchMatch[1])) continue

      for (const call of code.slice(open + 1, close).matchAll(/(?<![\w$.])redirect\s*\(/g)) {
        const offset = open + 1 + call.index
        if (seen.has(offset)) continue
        seen.add(offset)
        const lineStart = source.lastIndexOf('\n', offset - 1) + 1
        findings.push(redirectFinding(file, source.slice(0, offset).split('\n').length, offset - lineStart + 1))
      }
    }

    return findings
  },
}
