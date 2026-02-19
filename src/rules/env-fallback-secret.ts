import type { Rule, Finding, FileContext, ProjectContext } from '../types.js'
import { isCommentLine, isTestFile, isConfigFile } from '../utils/patterns.js'

const SENSITIVE_ENV = /process\.env\.(JWT_SECRET|SECRET_KEY|AUTH_SECRET|SESSION_SECRET|ENCRYPTION_KEY|API_SECRET|PRIVATE_KEY|SIGNING_KEY|NEXTAUTH_SECRET|TOKEN_SECRET|APP_SECRET|COOKIE_SECRET|HASH_SECRET)\s*(?:\|\||&&|\?\?)\s*['"`]/i

const ENV_FALLBACK = /process\.env\.\w*(SECRET|KEY|PASSWORD|TOKEN)\w*\s*(?:\|\||\?\?)\s*['"`]/i

export const envFallbackSecretRule: Rule = {
  id: 'env-fallback-secret',
  name: 'Secret with Fallback Value',
  description: 'Detects security-sensitive env vars with hardcoded fallback values — if the env var is missing, the fallback becomes the production secret',
  category: 'security',
  severity: 'critical',
  fileExtensions: ['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs'],

  check(file: FileContext, _project: ProjectContext): Finding[] {
    if (isTestFile(file.relativePath)) return []

    const findings: Finding[] = []

    for (let i = 0; i < file.lines.length; i++) {
      if (isCommentLine(file.lines, i, file.commentMap)) continue
      const line = file.lines[i]

      const directMatch = SENSITIVE_ENV.exec(line)
      if (directMatch) {
        findings.push({
          ruleId: 'env-fallback-secret',
          file: file.relativePath,
          line: i + 1,
          column: directMatch.index + 1,
          message: `Secret env var has a hardcoded fallback — if ${directMatch[1] || 'the var'} is unset, this literal becomes the production secret`,
          severity: 'critical',
          category: 'security',
          fix: 'Throw an error if the env var is missing: const secret = process.env.SECRET ?? (() => { throw new Error("SECRET is required") })()',
        })
        continue
      }

      const genericMatch = ENV_FALLBACK.exec(line)
      if (genericMatch && !isConfigFile(file.relativePath)) {
        findings.push({
          ruleId: 'env-fallback-secret',
          file: file.relativePath,
          line: i + 1,
          column: genericMatch.index + 1,
          message: 'Security-sensitive env var has a hardcoded fallback — defaults to a literal string when missing',
          severity: 'warning',
          category: 'security',
          fix: 'Fail fast when required env vars are missing instead of falling back to a default value',
        })
      }
    }

    return findings
  },
}
