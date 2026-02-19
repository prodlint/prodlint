import type { Rule, Finding, FileContext, ProjectContext } from '../types.js'
import { isCommentLine, isTestFile, isScriptFile } from '../utils/patterns.js'

const SECURITY_VAR_NAMES = /(?:token|secret|nonce|key|password|salt|session|csrf|otp|pin|code)/i
const MATH_RANDOM = /Math\.random\s*\(\)/

export const insecureRandomRule: Rule = {
  id: 'insecure-random',
  name: 'Insecure Random',
  description: 'Detects Math.random() used near security-sensitive variable names',
  category: 'security',
  severity: 'warning',
  fileExtensions: ['ts', 'tsx', 'js', 'jsx'],

  check(file: FileContext, _project: ProjectContext): Finding[] {
    if (isTestFile(file.relativePath)) return []
    if (isScriptFile(file.relativePath)) return []

    const findings: Finding[] = []

    for (let i = 0; i < file.lines.length; i++) {
      if (isCommentLine(file.lines, i, file.commentMap)) continue
      const line = file.lines[i]

      const match = MATH_RANDOM.exec(line)
      if (!match) continue

      // Check current line + 2 lines above for security variable names
      const context = file.lines.slice(Math.max(0, i - 2), i + 1).join('\n')
      if (SECURITY_VAR_NAMES.test(context)) {
        findings.push({
          ruleId: 'insecure-random',
          file: file.relativePath,
          line: i + 1,
          column: match.index + 1,
          message: 'Math.random() used in security-sensitive context — not cryptographically secure',
          severity: 'warning',
          category: 'security',
          fix: 'Use crypto.randomUUID() or crypto.getRandomValues() for security-sensitive values',
        })
      }
    }

    return findings
  },
}
