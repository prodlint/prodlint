import type { Rule, Finding, FileContext, ProjectContext } from '../types.js'
import { isCommentLine, isTestFile, isScriptFile } from '../utils/patterns.js'
import { walkAST } from '../utils/ast.js'
import type { Node, CallExpression, MemberExpression } from '@babel/types'

const PRISMA_WRITE_OPS = /prisma\.\w+\.(?:create|update|delete|upsert|createMany|updateMany|deleteMany)\s*\(/
const PRISMA_TRANSACTION = /\$transaction\s*\(/

const PRISMA_WRITE_METHODS = new Set([
  'create', 'update', 'delete', 'upsert',
  'createMany', 'updateMany', 'deleteMany',
])

export const missingTransactionRule: Rule = {
  id: 'missing-transaction',
  name: 'Missing Transaction',
  description: 'Detects multiple Prisma write operations without $transaction — atomicity risk',
  category: 'reliability',
  severity: 'warning',
  fileExtensions: ['ts', 'tsx', 'js', 'jsx'],

  check(file: FileContext, project: ProjectContext): Finding[] {
    if (isTestFile(file.relativePath)) return []
    if (isScriptFile(file.relativePath)) return []

    // Only check if Prisma is detected in the project
    if (!project.declaredDependencies.has('@prisma/client') && !project.detectedFrameworks.has('prisma')) return []

    // AST path: group writes by enclosing function scope
    if (file.ast) {
      try {
        // Build parent map
        const parentMap = new Map<Node, Node>()
        walkAST(file.ast.program, (node: Node, parent: Node | null) => {
          if (parent) parentMap.set(node, parent)
        })

        // Find all prisma write CallExpressions and $transaction calls
        const writesByScope = new Map<Node | null, { count: number; firstLine: number }>()
        const transactionScopes = new Set<Node | null>()

        walkAST(file.ast.program, (node: Node) => {
          if (node.type !== 'CallExpression') return
          const call = node as CallExpression
          if (!call.loc) return

          // Check for $transaction call
          if (call.callee.type === 'MemberExpression') {
            const mem = call.callee as MemberExpression
            if (mem.property.type === 'Identifier' && mem.property.name === '$transaction') {
              const scope = findEnclosingFunction(node, parentMap)
              transactionScopes.add(scope)
              return
            }
          }

          // Check for prisma.model.writeOp()
          if (call.callee.type !== 'MemberExpression') return
          const outerMem = call.callee as MemberExpression
          if (outerMem.property.type !== 'Identifier') return
          if (!PRISMA_WRITE_METHODS.has(outerMem.property.name)) return

          // Check it's prisma.something.writeOp
          if (outerMem.object.type !== 'MemberExpression') return
          const innerMem = outerMem.object as MemberExpression
          if (innerMem.object.type !== 'Identifier' || innerMem.object.name !== 'prisma') return

          const scope = findEnclosingFunction(node, parentMap)
          const existing = writesByScope.get(scope)
          if (existing) {
            existing.count++
          } else {
            writesByScope.set(scope, { count: 1, firstLine: call.loc.start.line })
          }
        })

        const findings: Finding[] = []
        for (const [scope, { count, firstLine }] of writesByScope) {
          if (count < 2) continue
          if (transactionScopes.has(scope)) continue
          findings.push({
            ruleId: 'missing-transaction',
            file: file.relativePath,
            line: firstLine,
            column: 1,
            message: `${count} Prisma write operations without $transaction — partial writes may leave inconsistent state`,
            severity: 'warning',
            category: 'reliability',
            fix: 'Wrap sequential writes in prisma.$transaction([...]) for atomicity',
          })
        }
        return findings
      } catch {
        // AST walk failed, fall through to regex
      }
    }

    // Regex fallback: file-wide counting
    let writeCount = 0
    let firstWriteLine = -1
    const hasTransaction = PRISMA_TRANSACTION.test(file.content)

    for (let i = 0; i < file.lines.length; i++) {
      if (isCommentLine(file.lines, i, file.commentMap)) continue
      if (PRISMA_WRITE_OPS.test(file.lines[i])) {
        writeCount++
        if (firstWriteLine === -1) firstWriteLine = i
      }
    }

    if (writeCount < 2 || hasTransaction) return []

    return [{
      ruleId: 'missing-transaction',
      file: file.relativePath,
      line: firstWriteLine + 1,
      column: 1,
      message: `${writeCount} Prisma write operations without $transaction — partial writes may leave inconsistent state`,
      severity: 'warning',
      category: 'reliability',
      fix: 'Wrap sequential writes in prisma.$transaction([...]) for atomicity',
    }]
  },
}

function findEnclosingFunction(node: Node, parentMap: Map<Node, Node>): Node | null {
  let current: Node | undefined = parentMap.get(node)
  while (current) {
    if (
      current.type === 'FunctionDeclaration' ||
      current.type === 'FunctionExpression' ||
      current.type === 'ArrowFunctionExpression'
    ) {
      return current
    }
    current = parentMap.get(current)
  }
  return null // top-level
}
