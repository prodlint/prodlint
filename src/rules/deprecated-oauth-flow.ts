import type { Rule, Finding, FileContext, ProjectContext } from '../types.js'
import { isCommentLine, isTestFile } from '../utils/patterns.js'

const IMPLICIT_GRANT = /response_type\s*[=:]\s*['"`]?token['"`]?/
const MISSING_PKCE = /authorization_code|code_challenge|code_verifier/

export const deprecatedOauthFlowRule: Rule = {
  id: 'deprecated-oauth-flow',
  name: 'Deprecated OAuth Flow',
  description: 'Detects OAuth Implicit Grant flow (response_type=token) — deprecated in OAuth 2.1, vulnerable to token interception',
  category: 'security',
  severity: 'warning',
  fileExtensions: ['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs'],

  check(file: FileContext, _project: ProjectContext): Finding[] {
    if (isTestFile(file.relativePath)) return []

    const findings: Finding[] = []

    for (let i = 0; i < file.lines.length; i++) {
      if (isCommentLine(file.lines, i, file.commentMap)) continue
      const line = file.lines[i]

      const match = IMPLICIT_GRANT.exec(line)
      if (match) {
        findings.push({
          ruleId: 'deprecated-oauth-flow',
          file: file.relativePath,
          line: i + 1,
          column: match.index + 1,
          message: 'OAuth Implicit Grant flow (response_type=token) is deprecated — tokens are exposed in the URL fragment',
          severity: 'warning',
          category: 'security',
          fix: 'Use Authorization Code flow with PKCE: response_type=code with code_challenge and code_verifier',
        })
      }
    }

    return findings
  },
}
