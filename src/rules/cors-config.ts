import type { Rule, Finding, FileContext, ProjectContext } from '../types.js'

export const corsConfigRule: Rule = {
  id: 'cors-config',
  name: 'Permissive CORS',
  description: 'Detects overly permissive CORS configuration',
  category: 'security',
  severity: 'warning',
  fileExtensions: ['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs'],

  check(file: FileContext, _project: ProjectContext): Finding[] {
    const findings: Finding[] = []

    for (let i = 0; i < file.lines.length; i++) {
      const line = file.lines[i]
      const trimmed = line.trim()

      // Skip comments and strings in regex/test patterns
      if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) continue

      // Check for Access-Control-Allow-Origin: *
      if (/['"]Access-Control-Allow-Origin['"]\s*[,:]\s*['"]\*['"]/.test(line)) {
        findings.push({
          ruleId: 'cors-config',
          file: file.relativePath,
          line: i + 1,
          column: line.indexOf('Access-Control') + 1,
          message: 'Access-Control-Allow-Origin set to "*" allows any domain',
          severity: 'warning',
          category: 'security',
        })
      }

      // Check for cors() with no arguments (allows all origins)
      if (/cors\(\s*\)/.test(line)) {
        findings.push({
          ruleId: 'cors-config',
          file: file.relativePath,
          line: i + 1,
          column: line.indexOf('cors(') + 1,
          message: 'cors() called without config allows all origins',
          severity: 'warning',
          category: 'security',
        })
      }

      // Check for origin: '*' in cors config
      if (/origin\s*:\s*['"]\*['"]/.test(line)) {
        findings.push({
          ruleId: 'cors-config',
          file: file.relativePath,
          line: i + 1,
          column: line.indexOf('origin') + 1,
          message: 'CORS origin set to "*" allows any domain',
          severity: 'warning',
          category: 'security',
        })
      }

      // Check for origin: true (mirrors any requesting origin)
      if (/origin\s*:\s*true/.test(line)) {
        findings.push({
          ruleId: 'cors-config',
          file: file.relativePath,
          line: i + 1,
          column: line.indexOf('origin') + 1,
          message: 'CORS origin set to true mirrors any requesting origin',
          severity: 'warning',
          category: 'security',
        })
      }
    }

    return findings
  },
}
