import type { Rule, Finding, FileContext, ProjectContext } from '../types.js'
import { isCommentLine, isTestFile } from '../utils/patterns.js'

const FS_WITH_USER_INPUT = [
  { pattern: /(?:readFile|readFileSync|createReadStream)\s*\(\s*(?:req|request)\.(?:query|body|params)/, msg: 'File read with user-controlled path — allows reading arbitrary files' },
  { pattern: /(?:readFile|readFileSync|createReadStream)\s*\(\s*(?:filePath|fileName|path|file|name)\s*[,)]/, msg: 'File read with potentially user-controlled path — validate before use' },
  { pattern: /(?:writeFile|writeFileSync|createWriteStream)\s*\(\s*(?:req|request)\.(?:query|body|params)/, msg: 'File write with user-controlled path — allows writing arbitrary files' },
  { pattern: /(?:unlink|unlinkSync|rm|rmSync)\s*\(\s*(?:req|request)\.(?:query|body|params)/, msg: 'File delete with user-controlled path — allows deleting arbitrary files' },
  { pattern: /path\.join\s*\([^)]*(?:req|request)\.(?:query|body|params)/, msg: 'path.join with user input — still vulnerable to traversal with ../' },
  { pattern: /\.sendFile\s*\(\s*(?:req|request)\.(?:query|body|params)/, msg: 'express.sendFile with user-controlled path — validate against a base directory' },
]

const SANITIZATION_PATTERNS = [
  /path\.resolve\s*\(.*\)\.startsWith/,
  /\.replace\s*\(\s*['"]\.\.['"],?\s*['"].*['"]\s*\)/,
  /\.includes\s*\(\s*['"]\.\.['"].*\)/,
  /normalize/,
  /sanitize/i,
  /realpath/,
]

export const pathTraversalRule: Rule = {
  id: 'path-traversal',
  name: 'Path Traversal',
  description: 'Detects filesystem operations with user-controlled paths — allows reading/writing arbitrary files via ../ sequences',
  category: 'security',
  severity: 'critical',
  fileExtensions: ['ts', 'tsx', 'js', 'jsx'],

  check(file: FileContext, _project: ProjectContext): Finding[] {
    if (isTestFile(file.relativePath)) return []

    const hasSanitization = SANITIZATION_PATTERNS.some(p => p.test(file.content))
    if (hasSanitization) return []

    const findings: Finding[] = []

    for (let i = 0; i < file.lines.length; i++) {
      if (isCommentLine(file.lines, i, file.commentMap)) continue
      const line = file.lines[i]

      for (const { pattern, msg } of FS_WITH_USER_INPUT) {
        const match = pattern.exec(line)
        if (match) {
          const severity = /req|request/.test(match[0]) ? 'critical' : 'warning'
          findings.push({
            ruleId: 'path-traversal',
            file: file.relativePath,
            line: i + 1,
            column: match.index + 1,
            message: msg,
            severity: severity as 'critical' | 'warning',
            category: 'security',
            fix: 'Validate the resolved path starts with an expected base directory: path.resolve(base, input).startsWith(path.resolve(base))',
          })
          break
        }
      }
    }

    return findings
  },
}
