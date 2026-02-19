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
import { unsafeHtmlRule } from './unsafe-html.js'
import { sqlInjectionRule } from './sql-injection.js'
import { placeholderContentRule } from './placeholder-content.js'
import { staleFallbackRule } from './stale-fallback.js'
import { hallucinatedApiRule } from './hallucinated-api.js'
import { openRedirectRule } from './open-redirect.js'
import { noSyncFsRule } from './no-sync-fs.js'
import { noNPlusOneRule } from './no-n-plus-one.js'
import { noDynamicImportLoopRule } from './no-dynamic-import-loop.js'
import { noUnboundedQueryRule } from './no-unbounded-query.js'
import { unhandledPromiseRule } from './unhandled-promise.js'
import { missingLoadingStateRule } from './missing-loading-state.js'
import { missingErrorBoundaryRule } from './missing-error-boundary.js'
import { codebaseConsistencyRule } from './codebase-consistency.js'
import { deadExportsRule } from './dead-exports.js'
import { shallowCatchRule } from './shallow-catch.js'
import { comprehensionDebtRule } from './comprehension-debt.js'
import { phantomDependencyRule } from './phantom-dependency.js'
import { insecureCookieRule } from './insecure-cookie.js'
import { leakedEnvInLogsRule } from './leaked-env-in-logs.js'
import { insecureRandomRule } from './insecure-random.js'
import { nextServerActionValidationRule } from './next-server-action-validation.js'
import { missingTransactionRule } from './missing-transaction.js'

export const rules: Rule[] = [
  // Security
  secretsRule,
  authChecksRule,
  envExposureRule,
  inputValidationRule,
  corsConfigRule,
  unsafeHtmlRule,
  sqlInjectionRule,
  openRedirectRule,
  rateLimitingRule,
  phantomDependencyRule,
  insecureCookieRule,
  leakedEnvInLogsRule,
  insecureRandomRule,
  nextServerActionValidationRule,
  // Reliability
  hallucinatedImportsRule,
  errorHandlingRule,
  unhandledPromiseRule,
  shallowCatchRule,
  missingLoadingStateRule,
  missingErrorBoundaryRule,
  missingTransactionRule,
  // Performance
  noSyncFsRule,
  noNPlusOneRule,
  noUnboundedQueryRule,
  noDynamicImportLoopRule,
  // AI Quality
  aiSmellsRule,
  placeholderContentRule,
  hallucinatedApiRule,
  staleFallbackRule,
  comprehensionDebtRule,
  codebaseConsistencyRule,
  deadExportsRule,
]
