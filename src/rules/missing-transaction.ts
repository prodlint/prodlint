import type { Rule, Finding, FileContext, ProjectContext } from '../types.js'
import { isCommentLine, isTestFile, isScriptFile } from '../utils/patterns.js'

const PRISMA_WRITE_OPS = /prisma\.\w+\.(?:create|update|delete|upsert|createMany|updateMany|deleteMany)\s*\(/
const PRISMA_TRANSACTION = /\$transaction\s*\(/

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

    // Count Prisma write operations (non-comment lines)
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

    // Only flag if 2+ writes without $transaction
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
