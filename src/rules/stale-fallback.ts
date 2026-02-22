import type { Rule, Finding, FileContext, ProjectContext } from '../types.js'
import { isCommentLine, isTestFile, isConfigFile, isScriptFile } from '../utils/patterns.js'

const STALE_PATTERNS: { pattern: RegExp; label: string }[] = [
  { pattern: /['"]http:\/\/localhost:\d+['"]/, label: 'Hardcoded localhost URL' },
  { pattern: /['"]https?:\/\/127\.0\.0\.1[/:'"]/, label: 'Hardcoded 127.0.0.1 URL' },
  { pattern: /['"]redis:\/\/localhost[/'"]/, label: 'Hardcoded Redis localhost URL' },
  { pattern: /['"]mongodb:\/\/localhost[/'"]/, label: 'Hardcoded MongoDB localhost URL' },
  { pattern: /['"]mongodb\+srv:\/\/localhost[/'"]/, label: 'Hardcoded MongoDB localhost URL' },
  { pattern: /['"]postgres:\/\/localhost[/'"]/, label: 'Hardcoded Postgres localhost URL' },
  { pattern: /['"]postgresql:\/\/localhost[/'"]/, label: 'Hardcoded Postgres localhost URL' },
  { pattern: /['"]amqp:\/\/localhost[/'"]/, label: 'Hardcoded AMQP localhost URL' },
]

export const staleFallbackRule: Rule = {
  id: 'stale-fallback',
  name: 'Stale Fallback',
  description: 'Detects hardcoded localhost URLs in non-config, non-test files',
  category: 'ai-quality',
  severity: 'warning',
  fileExtensions: ['ts', 'tsx', 'js', 'jsx'],

  check(file: FileContext, _project: ProjectContext): Finding[] {
    if (isTestFile(file.relativePath)) return []
    if (isConfigFile(file.relativePath)) return []
    if (isScriptFile(file.relativePath)) return []

    const findings: Finding[] = []

    for (let i = 0; i < file.lines.length; i++) {
      if (isCommentLine(file.lines, i, file.commentMap)) continue
      const line = file.lines[i]

      // Skip lines that use env vars with fallback (process.env.X || "http://localhost")
      // Still flag — that's the point: the fallback itself is stale

      for (const { pattern, label } of STALE_PATTERNS) {
        const match = pattern.exec(line)
        if (match) {
          findings.push({
            ruleId: 'stale-fallback',
            file: file.relativePath,
            line: i + 1,
            column: match.index + 1,
            message: `${label} — use environment variable instead`,
            severity: 'warning',
            category: 'ai-quality',
            fix: 'Replace hardcoded URL with an environment variable: process.env.DATABASE_URL or similar',
          })
          break
        }
      }
    }

    return findings
  },
}
