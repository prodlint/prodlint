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
