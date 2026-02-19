import type { Rule, Finding, FileContext, ProjectContext } from '../types.js'
import { isTestFile } from '../utils/patterns.js'

const CREATE_TABLE = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:public\.)?(\w+)/gi
const ENABLE_RLS = /ALTER\s+TABLE\s+(?:(?:public|"public")\.)?(\w+)\s+ENABLE\s+ROW\s+LEVEL\s+SECURITY/gi

export const supabaseMissingRlsRule: Rule = {
  id: 'supabase-missing-rls',
  name: 'Missing Row-Level Security',
  description: 'Detects SQL migrations that create tables without enabling Row-Level Security — all data is publicly accessible',
  category: 'security',
  severity: 'critical',
  fileExtensions: ['sql'],

  check(file: FileContext, project: ProjectContext): Finding[] {
    if (isTestFile(file.relativePath)) return []
    // Only check migration files
    if (!/migration|supabase|schema/i.test(file.relativePath)) return []

    const content = file.content
    const findings: Finding[] = []

    // Find all tables created
    const tables: { name: string; line: number }[] = []
    CREATE_TABLE.lastIndex = 0
    let match
    while ((match = CREATE_TABLE.exec(content)) !== null) {
      const name = match[1]
      // Skip internal/system tables
      if (name.startsWith('_') || name === 'schema_migrations') continue
      // Find line number
      const beforeMatch = content.slice(0, match.index)
      const line = beforeMatch.split('\n').length
      tables.push({ name, line })
    }

    if (tables.length === 0) return []

    // Find all tables with RLS enabled
    const rlsTables = new Set<string>()
    ENABLE_RLS.lastIndex = 0
    while ((match = ENABLE_RLS.exec(content)) !== null) {
      rlsTables.add(match[1].toLowerCase())
    }

    // Also check across all project SQL files
    for (const filePath of project.allFiles) {
      if (!filePath.endsWith('.sql')) continue
      if (filePath === file.relativePath) continue
    }

    for (const table of tables) {
      if (!rlsTables.has(table.name.toLowerCase())) {
        findings.push({
          ruleId: 'supabase-missing-rls',
          file: file.relativePath,
          line: table.line,
          column: 1,
          message: `Table "${table.name}" created without ENABLE ROW LEVEL SECURITY — all rows are publicly accessible via the Supabase API`,
          severity: 'critical',
          category: 'security',
          fix: `Add: ALTER TABLE ${table.name} ENABLE ROW LEVEL SECURITY; and create appropriate policies`,
        })
      }
    }

    return findings
  },
}
