import type { Rule, Finding, FileContext, ProjectContext } from '../types.js'
import { isCommentLine, isTestFile, isScriptFile } from '../utils/patterns.js'

const SENSITIVE_COOKIE_NAMES = /['"](?:session|token|auth|sid|jwt)['"]|\.set\s*\(\s*['"](?:session|token|auth|sid|jwt)['"]/i

// Next.js cookies().set() or Express res.cookie()
const COOKIE_SET_PATTERNS = [
  /cookies\(\)\s*\.set\s*\(/,
  /res\.cookie\s*\(/,
  /response\.cookies\.set\s*\(/,
]

const SECURE_OPTIONS = [
  /httpOnly\s*:\s*true/,
  /secure\s*:\s*true/,
  /sameSite\s*:/,
]

export const insecureCookieRule: Rule = {
  id: 'insecure-cookie',
  name: 'Insecure Cookie',
  description: 'Detects sensitive cookies set without httpOnly, secure, or sameSite options',
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

      const isCookieSet = COOKIE_SET_PATTERNS.some(p => p.test(line))
      if (!isCookieSet) continue

      // Check if the cookie name is security-sensitive
      if (!SENSITIVE_COOKIE_NAMES.test(line)) continue

      // Look ahead for secure options in the next few lines (options object may span lines)
      const block = file.lines.slice(i, Math.min(i + 8, file.lines.length)).join('\n')
      const missingOptions = SECURE_OPTIONS.filter(p => !p.test(block))

      if (missingOptions.length > 0) {
        const missing: string[] = []
        if (!/httpOnly\s*:\s*true/.test(block)) missing.push('httpOnly')
        if (!/secure\s*:\s*true/.test(block)) missing.push('secure')
        if (!/sameSite\s*:/.test(block)) missing.push('sameSite')

        findings.push({
          ruleId: 'insecure-cookie',
          file: file.relativePath,
          line: i + 1,
          column: 1,
          message: `Sensitive cookie missing security options: ${missing.join(', ')}`,
          severity: 'warning',
          category: 'security',
          fix: "Add { httpOnly: true, secure: true, sameSite: 'lax' } to cookie options",
        })
      }
    }

    return findings
  },
}
