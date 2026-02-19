import type { Rule, Finding, FileContext, ProjectContext } from '../types.js'
import { isCommentLine, isTestFile, isApiRoute } from '../utils/patterns.js'
import { walkAST, isStaticString, isUserInputNode } from '../utils/ast.js'
import type { Node, CallExpression, MemberExpression } from '@babel/types'

const USER_INPUT_IN_FETCH = [
  /fetch\s*\(\s*(?:req|request)\.(?:body|query|params|nextUrl)/,
  /fetch\s*\(\s*(?:url|href|endpoint|target|link|src)\s*[,)]/,
  /fetch\s*\(\s*searchParams\.get\s*\(/,
  /fetch\s*\(\s*formData\.get\s*\(/,
  /new\s+URL\s*\(\s*(?:req|request)\.(?:body|query)/,
  /axios\s*[.(]\s*(?:req|request)\.(?:body|query)/,
  /axios\.get\s*\(\s*(?:url|href|endpoint|target|link)\s*[,)]/,
]

const VALIDATION_PATTERNS = [
  /allowlist/i,
  /allowedUrls/i,
  /allowedHosts/i,
  /allowedDomains/i,
  /whitelist/i,
  /validUrl/i,
  /validateUrl/i,
  /URL\.canParse/,
  /new\s+URL\s*\(.*\)\.host/,
  /\.startsWith\s*\(\s*['"]https?:\/\//,
  /\.hostname\s*[!=]==?\s*['"`]/,
]

const SUSPICIOUS_URL_VARS = new Set([
  'url', 'href', 'endpoint', 'target', 'link', 'src',
])

export const ssrfRiskRule: Rule = {
  id: 'ssrf-risk',
  name: 'SSRF Risk',
  description: 'Detects fetch/HTTP calls with user-controlled URLs without validation — allows attackers to probe internal services',
  category: 'security',
  severity: 'warning',
  fileExtensions: ['ts', 'tsx', 'js', 'jsx'],

  check(file: FileContext, _project: ProjectContext): Finding[] {
    if (isTestFile(file.relativePath)) return []
    if (!isApiRoute(file.relativePath) && !/['"]use server['"]/.test(file.content)) return []

    const findings: Finding[] = []

    // AST path: per-call arg checking, no file-wide escape hatch for direct user input
    if (file.ast) {
      try {
        // For heuristic (variable name) checks, still respect validation patterns in code
        const hasValidationInCode = VALIDATION_PATTERNS.some(p => p.test(file.content))

        walkAST(file.ast.program, (node: Node) => {
          if (node.type !== 'CallExpression') return
          const call = node as CallExpression
          if (!call.loc) return

          // Match fetch() or axios.get/post/etc
          let isFetchLike = false
          if (call.callee.type === 'Identifier' && call.callee.name === 'fetch') {
            isFetchLike = true
          }
          if (call.callee.type === 'MemberExpression') {
            const mem = call.callee as MemberExpression
            if (mem.object.type === 'Identifier' && mem.object.name === 'axios') {
              isFetchLike = true
            }
          }
          if (!isFetchLike) return

          const arg = call.arguments[0]
          if (!arg) return

          // Static string → safe
          if (isStaticString(arg)) return

          const lineNum = call.loc.start.line
          const col = call.loc.start.column + 1

          // Direct user input → always flag (ignores file-wide escape)
          if (isUserInputNode(arg)) {
            findings.push({
              ruleId: 'ssrf-risk',
              file: file.relativePath,
              line: lineNum,
              column: col,
              message: 'User-controlled URL passed to fetch — validate against an allowlist to prevent SSRF',
              severity: 'warning',
              category: 'security',
              fix: 'Validate the URL against an allowlist of permitted domains before making the request',
            })
            return
          }

          // Suspicious variable name → skip if validation patterns exist in code
          if (arg.type === 'Identifier' && SUSPICIOUS_URL_VARS.has(arg.name)) {
            if (hasValidationInCode) return
            findings.push({
              ruleId: 'ssrf-risk',
              file: file.relativePath,
              line: lineNum,
              column: col,
              message: 'User-controlled URL passed to fetch — validate against an allowlist to prevent SSRF',
              severity: 'warning',
              category: 'security',
              fix: 'Validate the URL against an allowlist of permitted domains before making the request',
            })
          }
        })
        return findings
      } catch {
        // AST walk failed, fall through to regex
      }
    }

    // Regex fallback (keeps file-wide validation escape hatch)
    const hasValidation = VALIDATION_PATTERNS.some(p => p.test(file.content))
    if (hasValidation) return []

    for (let i = 0; i < file.lines.length; i++) {
      if (isCommentLine(file.lines, i, file.commentMap)) continue
      const line = file.lines[i]

      for (const pattern of USER_INPUT_IN_FETCH) {
        const match = pattern.exec(line)
        if (match) {
          findings.push({
            ruleId: 'ssrf-risk',
            file: file.relativePath,
            line: i + 1,
            column: match.index + 1,
            message: 'User-controlled URL passed to fetch — validate against an allowlist to prevent SSRF',
            severity: 'warning',
            category: 'security',
            fix: 'Validate the URL against an allowlist of permitted domains before making the request',
          })
          break
        }
      }
    }

    return findings
  },
}
