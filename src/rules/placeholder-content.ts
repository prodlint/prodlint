import type { Rule, Finding, FileContext, ProjectContext } from '../types.js'
import { isCommentLine, isTestFile } from '../utils/patterns.js'

const PLACEHOLDERS: { pattern: RegExp; label: string }[] = [
  { pattern: /Lorem ipsum/i, label: 'Lorem ipsum placeholder text' },
  { pattern: /example@example\.com/, label: 'Placeholder email "example@example.com"' },
  { pattern: /user@example\.com/, label: 'Placeholder email "user@example.com"' },
  { pattern: /test@test\.com/, label: 'Placeholder email "test@test.com"' },
  { pattern: /['"]John Doe['"]/, label: 'Placeholder name "John Doe"' },
  { pattern: /['"]Jane Doe['"]/, label: 'Placeholder name "Jane Doe"' },
  { pattern: /['"]password123['"]/, label: 'Placeholder password "password123"' },
  { pattern: /['"]changeme['"]/, label: 'Placeholder value "changeme"' },
  { pattern: /['"]your-api-key-here['"]/, label: 'Placeholder API key' },
  { pattern: /['"]replace-with-[^'"]*['"]/, label: 'Placeholder "replace-with-" value' },
  { pattern: /['"]xxx+['"]/, label: 'Placeholder "xxx" value' },
  { pattern: /['"]TODO:?\s*replace['"/]/i, label: 'TODO replace placeholder' },
]

export const placeholderContentRule: Rule = {
  id: 'placeholder-content',
  name: 'Placeholder Content',
  description: 'Detects Lorem ipsum, example emails, placeholder names, and dummy values in non-test files',
  category: 'ai-quality',
  severity: 'info',
  fileExtensions: ['ts', 'tsx', 'js', 'jsx'],

  check(file: FileContext, _project: ProjectContext): Finding[] {
    if (isTestFile(file.relativePath)) return []

    const findings: Finding[] = []

    for (let i = 0; i < file.lines.length; i++) {
      if (isCommentLine(file.lines, i, file.commentMap)) continue
      const line = file.lines[i]

      for (const { pattern, label } of PLACEHOLDERS) {
        const match = pattern.exec(line)
        if (match) {
          findings.push({
            ruleId: 'placeholder-content',
            file: file.relativePath,
            line: i + 1,
            column: match.index + 1,
            message: label,
            severity: 'info',
            category: 'ai-quality',
            fix: 'Replace placeholder content with real production values before deploying',
          })
          break // one finding per line
        }
      }
    }

    return findings
  },
}
