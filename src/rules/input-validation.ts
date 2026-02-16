import type { Rule, Finding, FileContext, ProjectContext } from '../types.js'
import { isApiRoute } from '../utils/patterns.js'

// Patterns indicating input validation is present
const VALIDATION_PATTERNS = [
  /\.parse\s*\(/,       // zod .parse()
  /\.safeParse\s*\(/,   // zod .safeParse()
  /\.validate\s*\(/,    // yup/joi .validate()
  /\.validateSync\s*\(/, // yup .validateSync()
  /Joi\.object/,
  /z\.object/,
  /z\.string/,
  /z\.number/,
  /z\.array/,
  /yup\.object/,
  /ajv/i,
  /typebox/i,
  /valibot/i,
  /typeof\s+.*body/,    // Basic typeof checks
]

// Patterns indicating request body access
const BODY_ACCESS_PATTERNS = [
  /req\.body/,
  /request\.json\(\)/,
  /await\s+req\.json\(\)/,
  /\.json\(\)\s*as\b/,
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

    // Check if body is accessed
    const accessesBody = BODY_ACCESS_PATTERNS.some(p => p.test(file.content))
    if (!accessesBody) return []

    // Check if validation exists
    const hasValidation = VALIDATION_PATTERNS.some(p => p.test(file.content))
    if (hasValidation) return []

    // Find the line where body is accessed
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
