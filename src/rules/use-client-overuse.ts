import type { Rule, Finding, FileContext, ProjectContext } from '../types.js'
import { isClientComponent, isTestFile, isConfigFile } from '../utils/patterns.js'

const CLIENT_APIS = [
  /\buseState\b/,
  /\buseEffect\b/,
  /\buseRef\b/,
  /\buseReducer\b/,
  /\buseCallback\b/,
  /\buseMemo\b/,
  /\buseContext\b/,
  /\buseLayoutEffect\b/,
  /\buseInsertionEffect\b/,
  /\buseTransition\b/,
  /\buseDeferredValue\b/,
  /\buseSyncExternalStore\b/,
  /\buseFormStatus\b/,
  /\buseFormState\b/,
  /\buseOptimistic\b/,
  /\bonClick\b\s*[=:]/,
  /\bonChange\b\s*[=:]/,
  /\bonSubmit\b\s*[=:]/,
  /\bonBlur\b\s*[=:]/,
  /\bonFocus\b\s*[=:]/,
  /\bonKeyDown\b\s*[=:]/,
  /\bonKeyUp\b\s*[=:]/,
  /\bonMouseDown\b\s*[=:]/,
  /\bonMouseUp\b\s*[=:]/,
  /\bonScroll\b\s*[=:]/,
  /\bonInput\b\s*[=:]/,
  /\bonDrag\b/,
  /\bonDrop\b/,
  /\bonTouchStart\b/,
  /\bcreateContext\b/,
  /\bwindow\./,
  /\bdocument\./,
  /\blocalStorage\b/,
  /\bsessionStorage\b/,
  /\bnavigator\b/,
  /\bIntersectionObserver\b/,
  /\bResizeObserver\b/,
  /\bMutationObserver\b/,
]

export const useClientOveruseRule: Rule = {
  id: 'use-client-overuse',
  name: '"use client" Overuse',
  description: 'Detects files with "use client" that don\'t use any client-side APIs — unnecessary client rendering',
  category: 'ai-quality',
  severity: 'info',
  fileExtensions: ['tsx', 'jsx'],

  check(file: FileContext, _project: ProjectContext): Finding[] {
    if (isTestFile(file.relativePath)) return []
    if (isConfigFile(file.relativePath)) return []
    if (!isClientComponent(file.content)) return []

    // Strip comments and strings for more accurate matching
    const usesClientApi = CLIENT_APIS.some(p => p.test(file.content))
    if (usesClientApi) return []

    return [{
      ruleId: 'use-client-overuse',
      file: file.relativePath,
      line: 1,
      column: 1,
      message: '"use client" directive but no client-side APIs (hooks, event handlers, browser APIs) — this component could be a server component',
      severity: 'info',
      category: 'ai-quality',
      fix: 'Remove "use client" to let Next.js render this as a server component for better performance',
    }]
  },
}
