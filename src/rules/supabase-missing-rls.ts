import type { Rule, Finding, FileContext, ProjectContext } from '../types.js'
import { isTestFile } from '../utils/patterns.js'

const CREATE_TABLE = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:public\.)?(\w+)/gi
// `ALTER TABLE [IF EXISTS] [ONLY] [public.]name`, any part of the name quoted or not
const ENABLE_RLS = /ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?(?:(?:public|"public")\.)?"?(\w+)"?\s+ENABLE\s+ROW\s+LEVEL\s+SECURITY/gi

/** Only migration and schema files create the tables an app ships */
function isMigrationFile(file: FileContext): boolean {
  return file.ext === 'sql' && !isTestFile(file.relativePath) &&
    /migration|supabase|schema/i.test(file.relativePath)
}

/**
 * The project a SQL file belongs to, so that separate projects in one repo (a monorepo's
 * apps or examples) don't vouch for each other's tables: the path before the file's
 * nearest `supabase/` directory, else before its nearest `migrations/`, else its directory.
 */
function sqlProject(relativePath: string): string {
  const dirs = relativePath.split('/').slice(0, -1)
  const supabase = dirs.map(d => d.toLowerCase() === 'supabase').lastIndexOf(true)
  const migrations = dirs.map(d => /^migrations?$/i.test(d)).lastIndexOf(true)
  const end = supabase !== -1 ? supabase : migrations !== -1 ? migrations : dirs.length
  return dirs.slice(0, end).join('/')
}

export const supabaseMissingRlsRule: Rule = {
  id: 'supabase-missing-rls',
  name: 'Missing Row-Level Security',
  description: 'Detects SQL migrations that create tables without enabling Row-Level Security — all data is publicly accessible',
  category: 'security',
  severity: 'critical',
  fileExtensions: ['sql'],

  check(): Finding[] {
    // Project-level: RLS is often enabled in a later migration than the one creating the table
    return []
  },

  checkProject(files: FileContext[], _project: ProjectContext): Finding[] {
    const findings: Finding[] = []

    // Tables with RLS enabled in any SQL file, per project: "<project>::<table>"
    const rlsTables = new Set<string>()
    for (const file of files) {
      if (file.ext !== 'sql' || isTestFile(file.relativePath)) continue
      const project = sqlProject(file.relativePath)
      for (const match of file.content.matchAll(ENABLE_RLS)) {
        rlsTables.add(`${project}::${match[1].toLowerCase()}`)
      }
    }

    for (const file of files) {
      if (!isMigrationFile(file)) continue
      const content = file.content
      const project = sqlProject(file.relativePath)

      for (const match of content.matchAll(CREATE_TABLE)) {
        const name = match[1]
        // Skip internal/system tables
        if (name.startsWith('_') || name === 'schema_migrations') continue
        if (rlsTables.has(`${project}::${name.toLowerCase()}`)) continue

        findings.push({
          ruleId: 'supabase-missing-rls',
          file: file.relativePath,
          line: content.slice(0, match.index).split('\n').length,
          column: 1,
          message: `Table "${name}" created without ENABLE ROW LEVEL SECURITY — all rows are publicly accessible via the Supabase API`,
          severity: 'critical',
          category: 'security',
          fix: `Add: ALTER TABLE ${name} ENABLE ROW LEVEL SECURITY; and create appropriate policies`,
        })
      }
    }

    return findings
  },
}
