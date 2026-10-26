import type { Rule, Finding, FileContext, ProjectContext } from '../types.js'
import { isTestFile, isScriptFile, blankOut, closingBrace } from '../utils/patterns.js'
import { walkAST } from '../utils/ast.js'
import type { Node } from '@babel/types'

interface CatchBody {
  /** Source between the braces */
  text: string
  /** No statements, only whitespace or comments */
  empty: boolean
  /** Source of each value the block returns, whole even when it spans lines */
  returned: string[]
  /** The caught error's name: `e` in `catch (e)` */
  param?: string
}

/**
 * Does a returned value report the error? `error` in any case (`isError: true`,
 * `'Error: ...'`), `err` starting a word (`errMsg`, `isErr`, but not `dateOverrides`),
 * `status`, a `Response`/`NextResponse`, `.json(...)`, or the caught error itself (`e.message`).
 */
function reportsError(value: string, param: string | undefined): boolean {
  if (/error/i.test(value) || /\berr|Err|status|Response|json/.test(value)) return true
  return param !== undefined && new RegExp(`(?<![\\w$])${param.replace(/\$/g, '\\$')}(?![\\w$])`).test(value)
}

/**
 * Score a catch block on error handling depth:
 * 0 = no handling: empty, or swallows the error (e.g. `return null`)
 * 1 = console.log only (decorative)
 * 2 = console.error or logs the error object
 * 3 = re-throws or returns error response
 */
function scoreCatchBody({ text: body, empty, returned, param }: CatchBody): { score: number; label: string } {
  if (empty) return { score: 0, label: 'empty catch' }

  let score = 0

  // Logs at all?
  if (/console\.(log|warn|error|info)\s*\(/.test(body)) score = 1
  // Logs the error object specifically?
  if ((/console\.(error|warn)\s*\(/.test(body) ||
       /\b(logger|log)\.(error|warn)\s*\(/.test(body)) && /\b(err|error|e)\b/.test(body)) score = 2
  // Re-throws, returns error response, sets error state, or uses proper error handling?
  if (/\bthrow\b/.test(body) ||
      returned.some(value => reportsError(value, param)) ||
      /\bset\w*Error\s*\(/.test(body) ||
      /\bres\.\w+\s*\(/.test(body) ||
      // Toast notifications (react-toastify, sonner, shadcn)
      /\btoast\.(error|warn|warning)\s*\(/.test(body) ||
      /\btoast\s*\(\s*\{/.test(body) ||
      // Error monitoring (Sentry, etc.)
      /\b(Sentry\.)?captureException\s*\(/.test(body) ||
      /\b(Sentry\.)?captureMessage\s*\(/.test(body) ||
      // Structured loggers
      /\b(logger|log)\.(error|fatal)\s*\(/.test(body) ||
      // Error handler utilities
      /\b(handleError|reportError|logError|notifyError|showError|onError|trackError)\s*\(/.test(body) ||
      // Express middleware: next(err)
      /\bnext\s*\(\s*(err|error|e)\s*\)/.test(body) ||
      // Next.js notFound()
      /\bnotFound\s*\(/.test(body)) {
    score = 3
  }

  const labels: Record<number, string> = {
    0: 'catch swallows the error',
    1: 'catch only logs (no recovery or propagation)',
    2: 'catch logs error but does not propagate or recover',
    3: 'catch handles error properly',
  }

  return { score, label: labels[score] }
}

/** The finding for a catch block that handles its error shallowly, or null */
function catchFinding(file: FileContext, catchLine: number, body: CatchBody): Finding | null {
  const { score, label } = scoreCatchBody(body)
  if (score > 1) return null

  return {
    ruleId: 'shallow-catch',
    file: file.relativePath,
    line: catchLine + 1,
    column: file.lines[catchLine].indexOf('catch') + 1,
    message: body.empty
      ? 'Empty catch block — errors are silently swallowed'
      : score === 0
        ? "Catch block swallows the error — it isn't logged, rethrown or returned"
        : `Decorative error handler: ${label}`,
    severity: score === 0 ? 'warning' : 'info',
    category: 'reliability',
    fix: 'Log the error with context and either re-throw, return an error response, or recover gracefully',
  }
}

/**
 * The regex fallback's stand-in for ReturnStatement arguments: what follows each
 * `return` up to the end of its statement — a `;` or line break outside brackets,
 * or the bracket that closes the enclosing block. `code` is `text` blanked out.
 */
function returnedValues(code: string, text: string): string[] {
  const values: string[] = []
  for (const m of code.matchAll(/(?<![\w$.])return\b/g)) {
    const start = m.index + 'return'.length
    let end = start
    for (let depth = 0; end < code.length; end++) {
      const ch = code[end]
      if (ch === '(' || ch === '[' || ch === '{') depth++
      else if (ch === ')' || ch === ']' || ch === '}') { if (depth-- === 0) break }
      else if (depth === 0 && (ch === ';' || ch === '\n')) break
    }
    values.push(text.slice(start, end))
  }
  return values
}

export const shallowCatchRule: Rule = {
  id: 'shallow-catch',
  name: 'Shallow Error Handler',
  description: 'Detects catch blocks that exist but do nothing useful — decorative error handling',
  category: 'reliability',
  severity: 'warning',
  fileExtensions: ['ts', 'tsx', 'js', 'jsx'],

  check(file: FileContext, _project: ProjectContext): Finding[] {
    if (isTestFile(file.relativePath)) return []
    if (isScriptFile(file.relativePath)) return []

    const findings: Finding[] = []

    // AST path: walk for CatchClause nodes
    if (file.ast) {
      try {
        walkAST(file.ast.program, (node: Node) => {
          if (node.type !== 'CatchClause') return
          if (!node.loc) return

          const catchLine = node.loc.start.line - 1 // 0-indexed
          const body = node.body // BlockStatement
          if (body?.start == null || body.end == null) return

          // Each returned value whole, so `return {\n  isError: true,\n}` is judged on all its lines
          const returned: string[] = []
          walkAST(body, (n: Node) => {
            if (n.type === 'ReturnStatement' && n.argument?.start != null && n.argument.end != null) {
              returned.push(file.content.slice(n.argument.start, n.argument.end))
            }
          })

          const finding = catchFinding(file, catchLine, {
            text: file.content.slice(body.start + 1, body.end - 1),
            empty: body.body.length === 0,
            returned,
            param: node.param?.type === 'Identifier' ? node.param.name : undefined,
          })
          if (finding) findings.push(finding)
        })
        return findings
      } catch {
        // AST walk failed, fall through to regex
      }
    }

    // Regex fallback, on the source with comments and string contents blanked out,
    // so braces and keywords inside them don't count
    const source = file.lines.join('\n')
    const code = blankOut(source, true)
    const noComments = blankOut(source, false)
    // `catch {` or `catch (e) {`, but not a promise's `.catch(`
    const catchRe = /(?<![\w$.])catch\s*(?:\(([^)]*)\)\s*)?\{/g
    let catchLine = 0 // 0-indexed line of the current match
    let scanned = 0
    for (let m = catchRe.exec(code); m; m = catchRe.exec(code)) {
      for (; scanned < m.index; scanned++) if (code[scanned] === '\n') catchLine++

      const open = m.index + m[0].length - 1
      const close = closingBrace(code, open)
      if (close === -1) continue

      const finding = catchFinding(file, catchLine, {
        text: source.slice(open + 1, close),
        empty: code.slice(open + 1, close).trim() === '',
        returned: returnedValues(code.slice(open + 1, close), noComments.slice(open + 1, close)),
        param: m[1]?.match(/^\s*([A-Za-z_$][\w$]*)/)?.[1],
      })
      if (finding) findings.push(finding)
    }

    return findings
  },
}
