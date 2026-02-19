import type { Rule, Finding, FileContext, ProjectContext } from '../types.js'
import { isCommentLine, isTestFile } from '../utils/patterns.js'
import { walkAST } from '../utils/ast.js'
import type { Node, CallExpression, MemberExpression, ObjectExpression } from '@babel/types'

const JWT_SIGN = /jwt\.sign\s*\(/

const HAS_EXPIRY = [
  /expiresIn/,
  /exp\s*:/,
  /expirationTime/,
  /maxAge/,
]

const EXPIRY_KEYS = new Set(['expiresIn', 'exp', 'expirationTime', 'maxAge'])

export const jwtNoExpiryRule: Rule = {
  id: 'jwt-no-expiry',
  name: 'JWT Without Expiration',
  description: 'Detects jwt.sign() calls without an expiresIn option — tokens never expire, compromised tokens are valid forever',
  category: 'security',
  severity: 'warning',
  fileExtensions: ['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs'],

  check(file: FileContext, _project: ProjectContext): Finding[] {
    if (isTestFile(file.relativePath)) return []
    if (!JWT_SIGN.test(file.content)) return []

    const findings: Finding[] = []

    // AST path: parse options object instead of 5-line context window
    if (file.ast) {
      try {
        walkAST(file.ast.program, (node: Node) => {
          if (node.type !== 'CallExpression') return
          const call = node as CallExpression
          if (!call.loc) return

          // Match jwt.sign()
          if (call.callee.type !== 'MemberExpression') return
          const mem = call.callee as MemberExpression
          if (mem.object.type !== 'Identifier' || mem.object.name !== 'jwt') return
          if (mem.property.type !== 'Identifier' || mem.property.name !== 'sign') return

          // jwt.sign(payload, secret, options?) or jwt.sign(payload, options?)
          // Check all ObjectExpression arguments for expiry keys
          let hasExpiry = false
          for (const arg of call.arguments) {
            if (arg.type === 'ObjectExpression') {
              const obj = arg as ObjectExpression
              for (const prop of obj.properties) {
                if (prop.type === 'ObjectProperty' && prop.key.type === 'Identifier' && EXPIRY_KEYS.has(prop.key.name)) {
                  hasExpiry = true
                  break
                }
              }
            }
            if (hasExpiry) break
          }

          // Also check if payload itself contains exp
          if (!hasExpiry && call.arguments[0]?.type === 'ObjectExpression') {
            const payload = call.arguments[0] as ObjectExpression
            for (const prop of payload.properties) {
              if (prop.type === 'ObjectProperty' && prop.key.type === 'Identifier' && prop.key.name === 'exp') {
                hasExpiry = true
                break
              }
            }
          }

          if (!hasExpiry) {
            findings.push({
              ruleId: 'jwt-no-expiry',
              file: file.relativePath,
              line: call.loc.start.line,
              column: call.loc.start.column + 1,
              message: 'jwt.sign() without expiresIn — tokens never expire, a compromised token is valid forever',
              severity: 'warning',
              category: 'security',
              fix: 'Add expiration: jwt.sign(payload, secret, { expiresIn: "1h" })',
            })
          }
        })
        return findings
      } catch {
        // AST walk failed, fall through to regex
      }
    }

    // Regex fallback: 5-line context window
    for (let i = 0; i < file.lines.length; i++) {
      if (isCommentLine(file.lines, i, file.commentMap)) continue
      const line = file.lines[i]

      const match = JWT_SIGN.exec(line)
      if (!match) continue

      // Check the next 5 lines for expiresIn option
      const context = file.lines.slice(i, i + 6).join('\n')
      const hasExpiry = HAS_EXPIRY.some(p => p.test(context))

      if (!hasExpiry) {
        findings.push({
          ruleId: 'jwt-no-expiry',
          file: file.relativePath,
          line: i + 1,
          column: match.index + 1,
          message: 'jwt.sign() without expiresIn — tokens never expire, a compromised token is valid forever',
          severity: 'warning',
          category: 'security',
          fix: 'Add expiration: jwt.sign(payload, secret, { expiresIn: "1h" })',
        })
      }
    }

    return findings
  },
}
