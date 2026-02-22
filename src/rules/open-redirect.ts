import type { Rule, Finding, FileContext, ProjectContext } from '../types.js'
import { isCommentLine } from '../utils/patterns.js'
import { walkAST, isStaticString, isUserInputNode } from '../utils/ast.js'
import type { Node, CallExpression, MemberExpression } from '@babel/types'

// Direct user input → warning (was critical — regex can't reliably distinguish)
const DIRECT_INPUT_PATTERNS: RegExp[] = [
  // redirect(searchParams.get(...)) or redirect(searchParams.get('x')!)
  /redirect\s*\(\s*(?:searchParams|query|params)\s*\.get\s*\(/,
  // redirect(req.query.x) or redirect(request.nextUrl.searchParams.get(...))
  /redirect\s*\(\s*req(?:uest)?\.(?:query|nextUrl\.searchParams\.get)\s*[.(]/,
  // NextResponse.redirect(new URL(userInput))
  /NextResponse\.redirect\s*\(\s*new\s+URL\s*\(\s*(?:searchParams|query|params)\s*\.get\s*\(/,
]

// Variable names that could be user input → warning (may be validated upstream)
const WARNING_PATTERNS: RegExp[] = [
  /redirect\s*\(\s*(?:url|returnUrl|returnTo|redirectUrl|redirectTo|next|callbackUrl|destination|redirect|goto|to|target|uri|href)\s*[,)]/,
]

const SUSPICIOUS_VAR_NAMES = new Set([
  'url', 'returnUrl', 'returnTo', 'redirectUrl', 'redirectTo',
  'next', 'callbackUrl', 'destination', 'redirect', 'goto',
  'to', 'target', 'uri', 'href',
])

export const openRedirectRule: Rule = {
  id: 'open-redirect',
  name: 'Open Redirect',
  description: 'Detects user-controlled input passed directly to redirect functions',
  category: 'security',
  severity: 'warning',
  fileExtensions: ['ts', 'tsx', 'js', 'jsx'],

  check(file: FileContext, _project: ProjectContext): Finding[] {
    const findings: Finding[] = []

    // AST path
    if (file.ast) {
      try {
        walkAST(file.ast.program, (node: Node) => {
          if (node.type !== 'CallExpression') return
          const call = node as CallExpression
          if (!call.loc) return

          // Match redirect() or NextResponse.redirect()
          let isRedirect = false
          if (call.callee.type === 'Identifier' && call.callee.name === 'redirect') {
            isRedirect = true
          }
          if (call.callee.type === 'MemberExpression') {
            const mem = call.callee as MemberExpression
            if (
              mem.object.type === 'Identifier' && mem.object.name === 'NextResponse' &&
              mem.property.type === 'Identifier' && mem.property.name === 'redirect'
            ) {
              isRedirect = true
            }
          }
          if (!isRedirect) return

          const arg = call.arguments[0]
          if (!arg) return

          // Static string arg → safe, skip
          if (isStaticString(arg)) return

          // For NextResponse.redirect(new URL(x, base)), check x
          let targetArg = arg
          if (arg.type === 'NewExpression' && arg.callee.type === 'Identifier' && arg.callee.name === 'URL') {
            targetArg = arg.arguments[0]
            if (!targetArg) return
            if (isStaticString(targetArg)) return
          }

          const lineNum = call.loc.start.line
          const col = call.loc.start.column + 1

          // User input → warning
          if (isUserInputNode(targetArg)) {
            findings.push({
              ruleId: 'open-redirect',
              file: file.relativePath,
              line: lineNum,
              column: col,
              message: 'User input in redirect — validate against an allowlist to prevent open redirect',
              severity: 'warning',
              category: 'security',
              fix: 'Validate the redirect URL against an allowlist of trusted domains',
            })
            return
          }

          // Suspicious variable name → warning
          if (targetArg.type === 'Identifier' && SUSPICIOUS_VAR_NAMES.has(targetArg.name)) {
            findings.push({
              ruleId: 'open-redirect',
              file: file.relativePath,
              line: lineNum,
              column: col,
              message: 'Possible user input in redirect — verify the URL is validated before use',
              severity: 'warning',
              category: 'security',
              fix: 'Validate the redirect URL against an allowlist of trusted domains',
            })
          }
        })
        return findings
      } catch {
        // AST walk failed, fall through to regex
      }
    }

    // Regex fallback
    for (let i = 0; i < file.lines.length; i++) {
      if (isCommentLine(file.lines, i, file.commentMap)) continue
      const line = file.lines[i]

      for (const pattern of DIRECT_INPUT_PATTERNS) {
        const match = pattern.exec(line)
        if (match) {
          findings.push({
            ruleId: 'open-redirect',
            file: file.relativePath,
            line: i + 1,
            column: match.index + 1,
            message: 'User input in redirect — validate against an allowlist to prevent open redirect',
            severity: 'warning',
            category: 'security',
            fix: 'Validate the redirect URL against an allowlist of trusted domains',
          })
          break
        }
      }

      for (const pattern of WARNING_PATTERNS) {
        const match = pattern.exec(line)
        if (match) {
          // Don't double-report if a direct input pattern already matched
          if (findings.some(f => f.line === i + 1)) break
          findings.push({
            ruleId: 'open-redirect',
            file: file.relativePath,
            line: i + 1,
            column: match.index + 1,
            message: 'Possible user input in redirect — verify the URL is validated before use',
            severity: 'warning',
            category: 'security',
            fix: 'Validate the redirect URL against an allowlist of trusted domains',
          })
          break
        }
      }
    }

    return findings
  },
}
