import type { Rule } from '../types.js'
import { secretsRule } from './secrets.js'
import { hallucinatedImportsRule } from './hallucinated-imports.js'
import { authChecksRule } from './auth-checks.js'
import { envExposureRule } from './env-exposure.js'
import { errorHandlingRule } from './error-handling.js'
import { inputValidationRule } from './input-validation.js'
import { rateLimitingRule } from './rate-limiting.js'
import { corsConfigRule } from './cors-config.js'
import { aiSmellsRule } from './ai-smells.js'

export const rules: Rule[] = [
  secretsRule,
  hallucinatedImportsRule,
  authChecksRule,
  envExposureRule,
  errorHandlingRule,
  inputValidationRule,
  rateLimitingRule,
  corsConfigRule,
  aiSmellsRule,
]
