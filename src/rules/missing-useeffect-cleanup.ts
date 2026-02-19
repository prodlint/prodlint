import type { Rule, Finding, FileContext, ProjectContext } from '../types.js'
import { isClientComponent, isTestFile } from '../utils/patterns.js'

const NEEDS_CLEANUP = [
  /\bsetInterval\s*\(/,
  /\baddEventListener\s*\(/,
  /\.subscribe\s*\(/,
  /\.on\s*\(\s*['"`]/,
  /new\s+WebSocket\s*\(/,
  /new\s+EventSource\s*\(/,
  /new\s+IntersectionObserver\s*\(/,
  /new\s+ResizeObserver\s*\(/,
  /new\s+MutationObserver\s*\(/,
]

export const missingUseEffectCleanupRule: Rule = {
  id: 'missing-useeffect-cleanup',
  name: 'Missing useEffect Cleanup',
  description: 'Detects useEffect hooks with subscriptions or timers but no cleanup return function — causes memory leaks',
  category: 'reliability',
  severity: 'warning',
  fileExtensions: ['tsx', 'jsx', 'ts', 'js'],

  check(file: FileContext, _project: ProjectContext): Finding[] {
    if (isTestFile(file.relativePath)) return []
    if (!isClientComponent(file.content)) return []
    if (!/useEffect/.test(file.content)) return []

    const findings: Finding[] = []
    const lines = file.lines

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      if (!/\buseEffect\s*\(/.test(line)) continue

      // Find the effect body boundaries via brace counting
      let braceDepth = 0
      let effectStart = -1
      let effectEnd = -1
      let started = false

      for (let j = i; j < lines.length && j < i + 100; j++) {
        for (const ch of lines[j]) {
          if (ch === '(') {
            if (!started) { started = true }
            braceDepth++
          } else if (ch === ')') {
            braceDepth--
            if (started && braceDepth === 0) {
              effectEnd = j
              break
            }
          } else if (ch === '{' && effectStart === -1 && started) {
            effectStart = j
          }
        }
        if (effectEnd !== -1) break
      }

      if (effectStart === -1 || effectEnd === -1) continue

      // Extract effect body
      const effectBody = lines.slice(effectStart, effectEnd + 1).join('\n')

      // Check if body uses patterns that need cleanup
      const needsCleanup = NEEDS_CLEANUP.some(p => p.test(effectBody))
      if (!needsCleanup) continue

      // Check if there's a return function (cleanup)
      const hasReturn = /return\s*(?:\(\s*\)\s*=>|function|\(\))/.test(effectBody) ||
        /return\s*\(\s*\)\s*\{/.test(effectBody) ||
        /return\s+\w+\s*;?\s*$/.test(effectBody)

      if (!hasReturn) {
        // More specific: check for return () => or return function
        const hasCleanupReturn = /return\s+(?:\(\)|(?:\(\s*\)\s*=>)|(?:function))/.test(effectBody)
        if (!hasCleanupReturn) {
          findings.push({
            ruleId: 'missing-useeffect-cleanup',
            file: file.relativePath,
            line: i + 1,
            column: 1,
            message: 'useEffect with subscription/timer but no cleanup return — will leak memory on unmount',
            severity: 'warning',
            category: 'reliability',
            fix: 'Return a cleanup function: useEffect(() => { const id = setInterval(...); return () => clearInterval(id); }, [])',
          })
        }
      }
    }

    return findings
  },
}
