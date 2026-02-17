import type { Rule, Finding, FileContext, ProjectContext } from '../types.js'
import { isApiRoute } from '../utils/patterns.js'

const VALIDATION_PATTERNS = [
  /\.parse\s*\(/,
  /\.safeParse\s*\(/,
  /\.validate\s*\(/,
  /\.validateSync\s*\(/,
  /Joi\.object/,
  /z\.object/,
  /z\.string/,
  /z\.number/,
  /z\.array/,
  /yup\.object/,
  /ajv/i,
  /typebox/i,
  /valibot/i,
  /typeof\s+.*body/,
  // Inline guard clauses on parsed body/data (\b prevents matching inside metadata, database, etc.)
  /if\s*\(\s*!\b(body|data)\b\./,
  /\b(body|data)\b\?\.\w+\s*(!==|===)/,
  /typeof\s+\b(body|data)\b/,
]

const BODY_ACCESS_PATTERNS = [
  /req\.body/,
  /request\.json\s*\(\)/,
  /req\.json\s*\(\)/,
]

export const inputValidationRule: Rule = {
  id: 'input-validation',
  name: 'Missing Input Validation',
  description: 'Detects API routes that access request body without validation',
  category: 'security',
  severity: 'warning',
  fileExtensions: ['ts', 'tsx', 'js', 'jsx'],

  check(file: FileContext, _project: ProjectContext): Finding[] {
    if (!isApiRoute(file.relativePath)) return []

    const accessesBody = BODY_ACCESS_PATTERNS.some(p => p.test(file.content))
    if (!accessesBody) return []

    const hasValidation = VALIDATION_PATTERNS.some(p => p.test(file.content))
    if (hasValidation) return []

    let bodyLine = 1
    for (let i = 0; i < file.lines.length; i++) {
      if (BODY_ACCESS_PATTERNS.some(p => p.test(file.lines[i]))) {
        bodyLine = i + 1
        break
      }
    }

    return [{
      ruleId: 'input-validation',
      file: file.relativePath,
      line: bodyLine,
      column: 1,
      message: 'Request body accessed without validation (consider using Zod, Yup, or similar)',
      severity: 'warning',
      category: 'security',
    }]
  },
}
