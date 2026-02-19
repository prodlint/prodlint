import type { Rule, Finding, FileContext, ProjectContext } from '../types.js'
import { isCommentLine, isTestFile, isScriptFile } from '../utils/patterns.js'
import { walkAST, subtreeContains } from '../utils/ast.js'
import type { Node, CallExpression, MemberExpression } from '@babel/types'

const CONSOLE_WITH_ENV = /console\.(log|warn|error|info|debug)\s*\([^)]*process\.env\./

const CONSOLE_METHODS = new Set(['log', 'warn', 'error', 'info', 'debug'])

export const leakedEnvInLogsRule: Rule = {
  id: 'leaked-env-in-logs',
  name: 'Leaked Env in Logs',
  description: 'Detects process.env values logged to console — potential secret exposure',
  category: 'security',
  severity: 'warning',
  fileExtensions: ['ts', 'tsx', 'js', 'jsx'],

  check(file: FileContext, _project: ProjectContext): Finding[] {
    if (isTestFile(file.relativePath)) return []
    if (isScriptFile(file.relativePath)) return []

    const findings: Finding[] = []

    // AST path: walk call args for MemberExpression (skip string literals)
    if (file.ast) {
      try {
        walkAST(file.ast.program, (node: Node) => {
          if (node.type !== 'CallExpression') return
          const call = node as CallExpression
          if (!call.loc) return

          // Match console.log/warn/error/info/debug
          if (call.callee.type !== 'MemberExpression') return
          const mem = call.callee as MemberExpression
          if (mem.object.type !== 'Identifier' || mem.object.name !== 'console') return
          if (mem.property.type !== 'Identifier' || !CONSOLE_METHODS.has(mem.property.name)) return

          // Walk argument subtrees for process.env.* MemberExpression
          let hasEnvAccess = false
          for (const arg of call.arguments) {
            if (subtreeContains(arg, (n: Node) => {
              if (n.type !== 'MemberExpression') return false
              const m = n as MemberExpression
              // process.env.X
              if (m.object.type === 'MemberExpression') {
                const inner = m.object as MemberExpression
                return inner.object.type === 'Identifier' && inner.object.name === 'process' &&
                       inner.property.type === 'Identifier' && inner.property.name === 'env'
              }
              return false
            })) {
              hasEnvAccess = true
              break
            }
          }

          if (hasEnvAccess) {
            findings.push({
              ruleId: 'leaked-env-in-logs',
              file: file.relativePath,
              line: call.loc.start.line,
              column: call.loc.start.column + 1,
              message: 'process.env value in console output — may leak secrets in production logs',
              severity: 'warning',
              category: 'security',
              fix: 'Remove process.env.* from console output — log a redacted summary instead',
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

      const match = CONSOLE_WITH_ENV.exec(line)
      if (match) {
        findings.push({
          ruleId: 'leaked-env-in-logs',
          file: file.relativePath,
          line: i + 1,
          column: match.index + 1,
          message: 'process.env value in console output — may leak secrets in production logs',
          severity: 'warning',
          category: 'security',
          fix: 'Remove process.env.* from console output — log a redacted summary instead',
        })
      }
    }

    return findings
  },
}
