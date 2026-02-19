import type { Rule, Finding, FileContext, ProjectContext } from '../types.js'
import { isCommentLine, isTestFile } from '../utils/patterns.js'

const EVAL_PATTERNS = [
  { pattern: /\beval\s*\(/, msg: 'eval() executes arbitrary code — never use with dynamic input' },
  { pattern: /\bnew\s+Function\s*\(/, msg: 'new Function() is equivalent to eval — avoid dynamic code execution' },
  { pattern: /\bsetTimeout\s*\(\s*['"`]/, msg: 'setTimeout with a string argument is eval — pass a function instead' },
  { pattern: /\bsetInterval\s*\(\s*['"`]/, msg: 'setInterval with a string argument is eval — pass a function instead' },
]

export const evalInjectionRule: Rule = {
  id: 'eval-injection',
  name: 'Eval / Code Injection',
  description: 'Detects eval(), new Function(), and string arguments to setTimeout/setInterval',
  category: 'security',
  severity: 'critical',
  fileExtensions: ['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs'],

  check(file: FileContext, _project: ProjectContext): Finding[] {
    if (isTestFile(file.relativePath)) return []

    const findings: Finding[] = []

    for (let i = 0; i < file.lines.length; i++) {
      if (isCommentLine(file.lines, i, file.commentMap)) continue
      const line = file.lines[i]

      for (const { pattern, msg } of EVAL_PATTERNS) {
        const match = pattern.exec(line)
        if (match) {
          findings.push({
            ruleId: 'eval-injection',
            file: file.relativePath,
            line: i + 1,
            column: match.index + 1,
            message: msg,
            severity: 'critical',
            category: 'security',
          })
          break
        }
      }
    }

    return findings
  },
}
