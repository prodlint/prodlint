import type { Rule, Finding, FileContext, ProjectContext } from '../types.js'
import { isTestFile } from '../utils/patterns.js'

const USE_SERVER = /['"]use server['"]/
const FORM_DATA_GET = /formData\.get\s*\(/
const VALIDATION_PATTERNS = [
  /\.parse\s*\(/,
  /\.safeParse\s*\(/,
  /\bvalidate\s*\(/,
  /\.parseAsync\s*\(/,
  /\.safeParseAsync\s*\(/,
]

export const nextServerActionValidationRule: Rule = {
  id: 'next-server-action-validation',
  name: 'Next.js Server Action Validation',
  description: 'Detects server actions using formData without schema validation — unvalidated user input',
  category: 'security',
  severity: 'critical',
  fileExtensions: ['ts', 'tsx', 'js', 'jsx'],

  check(file: FileContext, _project: ProjectContext): Finding[] {
    if (isTestFile(file.relativePath)) return []

    // Must have 'use server' directive
    if (!USE_SERVER.test(file.content)) return []

    // Must use formData.get()
    if (!FORM_DATA_GET.test(file.content)) return []

    // Check if any validation is present
    const hasValidation = VALIDATION_PATTERNS.some(p => p.test(file.content))
    if (hasValidation) return []

    // Find the first formData.get() line for reporting
    let reportLine = 1
    for (let i = 0; i < file.lines.length; i++) {
      if (FORM_DATA_GET.test(file.lines[i])) {
        reportLine = i + 1
        break
      }
    }

    return [{
      ruleId: 'next-server-action-validation',
      file: file.relativePath,
      line: reportLine,
      column: 1,
      message: 'Server action reads formData without schema validation — unvalidated user input',
      severity: 'critical',
      category: 'security',
      fix: 'Validate with Zod: const data = schema.safeParse(Object.fromEntries(formData))',
    }]
  },
}
