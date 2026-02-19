import type { Rule, Finding, FileContext, ProjectContext } from '../types.js'
import { isCommentLine } from '../utils/patterns.js'

// Direct user input → warning (was critical — regex can't reliably distinguish)
const DIRECT_INPUT_PATTERNS: RegExp[] = [
  // redirect(searchParams.get(...)) or redirect(searchParams.get('x')!)
  /redirect\s*\(\s*(?:searchParams|query|params)\s*\.get\s*\(/,
  // redirect(req.query.x) or redirect(request.nextUrl.searchParams.get(...))
  /redirect\s*\(\s*req(?:uest)?\.(?:query|nextUrl\.searchParams\.get)\s*[.(]/,
  // NextResponse.redirect(new URL(userInput))
  /NextResponse\.redirect\s*\(\s*new\s+URL\s*\(\s*(?:searchParams|query|params)\s*\.get\s*\(/,
]

// Variable names that could be user input → warning (may be validated upstream)
const WARNING_PATTERNS: RegExp[] = [
  /redirect\s*\(\s*(?:url|returnUrl|returnTo|redirectUrl|redirectTo|next|callbackUrl|destination|redirect|goto|to|target|uri|href)\s*[,)]/,
]

export const openRedirectRule: Rule = {
  id: 'open-redirect',
  name: 'Open Redirect',
  description: 'Detects user-controlled input passed directly to redirect functions',
  category: 'security',
  severity: 'warning',
  fileExtensions: ['ts', 'tsx', 'js', 'jsx'],

  check(file: FileContext, _project: ProjectContext): Finding[] {
    const findings: Finding[] = []

    for (let i = 0; i < file.lines.length; i++) {
      if (isCommentLine(file.lines, i, file.commentMap)) continue
      const line = file.lines[i]

      for (const pattern of DIRECT_INPUT_PATTERNS) {
        const match = pattern.exec(line)
        if (match) {
          findings.push({
            ruleId: 'open-redirect',
            file: file.relativePath,
            line: i + 1,
            column: match.index + 1,
            message: 'User input in redirect — validate against an allowlist to prevent open redirect',
            severity: 'warning',
            category: 'security',
          })
          break
        }
      }

      for (const pattern of WARNING_PATTERNS) {
        const match = pattern.exec(line)
        if (match) {
          // Don't double-report if a direct input pattern already matched
          if (findings.some(f => f.line === i + 1)) break
          findings.push({
            ruleId: 'open-redirect',
            file: file.relativePath,
            line: i + 1,
            column: match.index + 1,
            message: 'Possible user input in redirect — verify the URL is validated before use',
            severity: 'warning',
            category: 'security',
          })
          break
        }
      }
    }

    return findings
  },
}
