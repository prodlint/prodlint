import type { Rule, Finding, FileContext, ProjectContext } from '../types.js'
import { isTestFile } from '../utils/patterns.js'

const USE_SERVER = /['"]use server['"]/
const DB_MUTATIONS = [
  /\.insert\s*\(/,
  /\.update\s*\(/,
  /\.delete\s*\(/,
  /\.upsert\s*\(/,
  /\.create\s*\(/,
  /\.createMany\s*\(/,
  /\.updateMany\s*\(/,
  /\.deleteMany\s*\(/,
  /\.remove\s*\(/,
  /\.save\s*\(/,
  /\.destroy\s*\(/,
]
const REVALIDATION = [
  /revalidatePath\s*\(/,
  /revalidateTag\s*\(/,
  /redirect\s*\(/,
]

export const missingRevalidationRule: Rule = {
  id: 'missing-revalidation',
  name: 'Missing Revalidation After Mutation',
  description: 'Detects server actions that mutate data without calling revalidatePath or revalidateTag — UI shows stale data',
  category: 'reliability',
  severity: 'warning',
  fileExtensions: ['ts', 'tsx', 'js', 'jsx'],

  check(file: FileContext, _project: ProjectContext): Finding[] {
    if (isTestFile(file.relativePath)) return []
    if (!USE_SERVER.test(file.content)) return []

    const hasMutation = DB_MUTATIONS.some(p => p.test(file.content))
    if (!hasMutation) return []

    const hasRevalidation = REVALIDATION.some(p => p.test(file.content))
    if (hasRevalidation) return []

    // Find first mutation line
    let reportLine = 1
    for (let i = 0; i < file.lines.length; i++) {
      if (DB_MUTATIONS.some(p => p.test(file.lines[i]))) {
        reportLine = i + 1
        break
      }
    }

    return [{
      ruleId: 'missing-revalidation',
      file: file.relativePath,
      line: reportLine,
      column: 1,
      message: 'Server action mutates data without revalidatePath() or revalidateTag() — UI will show stale data',
      severity: 'warning',
      category: 'reliability',
      fix: 'Add revalidatePath("/affected-route") after the mutation',
    }]
  },
}
