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
// New rules (v0.6.0)
import { redirectInTryCatchRule } from './redirect-in-try-catch.js'
import { missingRevalidationRule } from './missing-revalidation.js'
import { useClientOveruseRule } from './use-client-overuse.js'
import { envFallbackSecretRule } from './env-fallback-secret.js'
import { verboseErrorResponseRule } from './verbose-error-response.js'
import { missingWebhookVerificationRule } from './missing-webhook-verification.js'
import { serverActionAuthRule } from './server-action-auth.js'
import { evalInjectionRule } from './eval-injection.js'
import { missingUseEffectCleanupRule } from './missing-useeffect-cleanup.js'
import { nextPublicSensitiveRule } from './next-public-sensitive.js'
import { ssrfRiskRule } from './ssrf-risk.js'
import { pathTraversalRule } from './path-traversal.js'
import { hydrationMismatchRule } from './hydration-mismatch.js'
import { serverComponentFetchSelfRule } from './server-component-fetch-self.js'
import { unsafeFileUploadRule } from './unsafe-file-upload.js'
import { supabaseMissingRlsRule } from './supabase-missing-rls.js'
import { deprecatedOauthFlowRule } from './deprecated-oauth-flow.js'
import { jwtNoExpiryRule } from './jwt-no-expiry.js'
import { clientSideAuthOnlyRule } from './client-side-auth-only.js'
import { missingAbortControllerRule } from './missing-abort-controller.js'

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
  envFallbackSecretRule,
  verboseErrorResponseRule,
  missingWebhookVerificationRule,
  serverActionAuthRule,
  evalInjectionRule,
  nextPublicSensitiveRule,
  ssrfRiskRule,
  pathTraversalRule,
  unsafeFileUploadRule,
  supabaseMissingRlsRule,
  deprecatedOauthFlowRule,
  jwtNoExpiryRule,
  clientSideAuthOnlyRule,
  // Reliability
  hallucinatedImportsRule,
  errorHandlingRule,
  unhandledPromiseRule,
  shallowCatchRule,
  missingLoadingStateRule,
  missingErrorBoundaryRule,
  missingTransactionRule,
  redirectInTryCatchRule,
  missingRevalidationRule,
  missingUseEffectCleanupRule,
  hydrationMismatchRule,
  // Performance
  noSyncFsRule,
  noNPlusOneRule,
  noUnboundedQueryRule,
  noDynamicImportLoopRule,
  serverComponentFetchSelfRule,
  missingAbortControllerRule,
  // AI Quality
  aiSmellsRule,
  placeholderContentRule,
  hallucinatedApiRule,
  staleFallbackRule,
  comprehensionDebtRule,
  codebaseConsistencyRule,
  deadExportsRule,
  useClientOveruseRule,
]
