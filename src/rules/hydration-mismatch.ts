import type { Rule, Finding, FileContext, ProjectContext } from '../types.js'
import { isClientComponent, isCommentLine, isTestFile } from '../utils/patterns.js'
import { findUseEffectRanges } from '../utils/ast.js'

const BROWSER_ONLY_PATTERNS = [
  { pattern: /\bwindow\./, msg: 'window access in server-rendered code — will differ between server and client' },
  { pattern: /\bdocument\./, msg: 'document access in server-rendered code — undefined on the server' },
  { pattern: /\blocalStorage\b/, msg: 'localStorage in render path — undefined on server, causes hydration mismatch' },
  { pattern: /\bsessionStorage\b/, msg: 'sessionStorage in render path — undefined on server, causes hydration mismatch' },
  { pattern: /\bnavigator\./, msg: 'navigator access in render path — undefined on server' },
]

const NONDETERMINISTIC_PATTERNS = [
  { pattern: /\bnew\s+Date\s*\(\s*\)/, msg: 'new Date() in render path — server and client will have different timestamps, causing hydration mismatch' },
  { pattern: /\bDate\.now\s*\(\s*\)/, msg: 'Date.now() in render path — different on server vs client' },
  { pattern: /\bMath\.random\s*\(\s*\)/, msg: 'Math.random() in render path — produces different values on server vs client' },
]

export const hydrationMismatchRule: Rule = {
  id: 'hydration-mismatch',
  name: 'Hydration Mismatch Risk',
  description: 'Detects browser-only APIs and non-deterministic calls in server component render paths',
  category: 'reliability',
  severity: 'warning',
  fileExtensions: ['tsx', 'jsx', 'ts', 'js'],

  check(file: FileContext, _project: ProjectContext): Finding[] {
    if (isTestFile(file.relativePath)) return []

    // Only flag in server components (no "use client")
    if (isClientComponent(file.content)) return []

    // Must be in app/ directory to be a server component
    if (!/(?:^|\/)(?:src\/)?app\//.test(file.relativePath)) return []

    // Skip route.ts (API routes)
    if (/route\.[jt]sx?$/.test(file.relativePath)) return []

    const findings: Finding[] = []

    // Build useEffect line ranges (AST-based if available)
    let useEffectRanges: Array<{ start: number; end: number }> = []
    if (file.ast) {
      try {
        useEffectRanges = findUseEffectRanges(file.ast)
      } catch {
        // Fall through to regex-based tracking
      }
    }

    const hasAstRanges = useEffectRanges.length > 0 || (file.ast != null)
    let insideUseEffect = false

    for (let i = 0; i < file.lines.length; i++) {
      if (isCommentLine(file.lines, i, file.commentMap)) continue
      const line = file.lines[i]

      // Check if line is inside a useEffect callback
      if (hasAstRanges) {
        // AST path: use precise ranges
        const inEffect = useEffectRanges.some(r => i >= r.start && i <= r.end)
        if (inEffect) continue
      } else {
        // Regex fallback: rough tracking
        if (/\buseEffect\s*\(/.test(line)) {
          insideUseEffect = true
        }
        if (insideUseEffect) {
          if (/^\s*\}\s*,\s*\[/.test(line) || /^\s*\}\s*\)\s*;?\s*$/.test(line)) {
            insideUseEffect = false
          }
          continue
        }
      }

      for (const { pattern, msg } of [...BROWSER_ONLY_PATTERNS, ...NONDETERMINISTIC_PATTERNS]) {
        const match = pattern.exec(line)
        if (match) {
          findings.push({
            ruleId: 'hydration-mismatch',
            file: file.relativePath,
            line: i + 1,
            column: match.index + 1,
            message: msg,
            severity: 'warning',
            category: 'reliability',
            fix: 'Move this to a useEffect hook, or add "use client" if this component needs browser APIs',
          })
          break
        }
      }
    }

    return findings
  },
}
