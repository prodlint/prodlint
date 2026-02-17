import type { Rule, Finding, FileContext, ProjectContext } from '../types.js'
import { isCommentLine } from '../utils/patterns.js'

export const unsafeHtmlRule: Rule = {
  id: 'unsafe-html',
  name: 'Unsafe HTML Rendering',
  description: 'Detects dangerouslySetInnerHTML and other XSS vectors in JSX/DOM code',
  category: 'security',
  severity: 'critical',
  fileExtensions: ['ts', 'tsx', 'js', 'jsx'],

  check(file: FileContext, _project: ProjectContext): Finding[] {
    const findings: Finding[] = []

    for (let i = 0; i < file.lines.length; i++) {
      if (isCommentLine(file.lines, i, file.commentMap)) continue

      const line = file.lines[i]

      // Only match dangerouslySetInnerHTML in JSX attribute position (after = or with {)
      // Avoids matching inside string literals, variable names, or regex patterns
      if (/dangerouslySetInnerHTML\s*=/.test(line) || /dangerouslySetInnerHTML\s*:/.test(line)) {
        // JSON-LD exception: JSON.stringify in the __html value is provably safe
        // Check current line and the next 2 lines, but only if they're part of the same JSX expression
        // (i.e. no closing tag or new statement in between)
        const context: string[] = [line]
        for (let j = 1; j <= 2 && i + j < file.lines.length; j++) {
          const nextLine = file.lines[i + j]
          // Stop if we hit a line that looks like a new statement or JSX element
          if (/^\s*<[^/]|^\s*(const|let|var|return|export|import)\s/.test(nextLine)) break
          context.push(nextLine)
        }
        const expr = context.join(' ')
        if (/__html\s*:\s*JSON\.stringify/.test(expr)) continue

        findings.push({
          ruleId: 'unsafe-html',
          file: file.relativePath,
          line: i + 1,
          column: line.indexOf('dangerouslySetInnerHTML') + 1,
          message: 'dangerouslySetInnerHTML is an XSS risk — sanitize with DOMPurify or similar',
          severity: 'critical',
          category: 'security',
        })
      }

      // innerHTML assignment (actual DOM mutation, not inside a string)
      if (/\w\.innerHTML\s*=/.test(line)) {
        findings.push({
          ruleId: 'unsafe-html',
          file: file.relativePath,
          line: i + 1,
          column: line.indexOf('.innerHTML') + 1,
          message: 'Direct innerHTML assignment is an XSS risk',
          severity: 'critical',
          category: 'security',
        })
      }
    }

    return findings
  },
}
