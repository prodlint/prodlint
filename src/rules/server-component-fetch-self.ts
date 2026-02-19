import type { Rule, Finding, FileContext, ProjectContext } from '../types.js'
import { isClientComponent, isCommentLine, isTestFile } from '../utils/patterns.js'

const SELF_FETCH_PATTERNS = [
  /fetch\s*\(\s*['"`]\/api\//,
  /fetch\s*\(\s*['"`]http:\/\/localhost/,
  /fetch\s*\(\s*['"`]https?:\/\/localhost/,
  /fetch\s*\(\s*`\$\{.*\}\/api\//,
  /fetch\s*\(\s*(?:process\.env\.\w+\s*\+\s*)?['"`]\/api\//,
]

export const serverComponentFetchSelfRule: Rule = {
  id: 'server-component-fetch-self',
  name: 'Server Component Fetching Own API',
  description: 'Detects server components that fetch their own API routes instead of calling data logic directly — unnecessary network roundtrip',
  category: 'performance',
  severity: 'info',
  fileExtensions: ['tsx', 'jsx', 'ts', 'js'],

  check(file: FileContext, _project: ProjectContext): Finding[] {
    if (isTestFile(file.relativePath)) return []

    // Only flag server components (no "use client")
    if (isClientComponent(file.content)) return []

    // Must be in app/ directory
    if (!/(?:^|\/)(?:src\/)?app\//.test(file.relativePath)) return []
    // Skip API routes themselves
    if (/route\.[jt]sx?$/.test(file.relativePath)) return []

    const findings: Finding[] = []

    for (let i = 0; i < file.lines.length; i++) {
      if (isCommentLine(file.lines, i, file.commentMap)) continue
      const line = file.lines[i]

      for (const pattern of SELF_FETCH_PATTERNS) {
        const match = pattern.exec(line)
        if (match) {
          findings.push({
            ruleId: 'server-component-fetch-self',
            file: file.relativePath,
            line: i + 1,
            column: match.index + 1,
            message: 'Server component fetches its own API route — call the data logic directly instead of making a network request to yourself',
            severity: 'info',
            category: 'performance',
            fix: 'Import and call the data function directly instead of fetch("/api/...")',
          })
          break
        }
      }
    }

    return findings
  },
}
