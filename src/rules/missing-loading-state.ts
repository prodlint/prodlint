import type { Rule, Finding, FileContext, ProjectContext } from '../types.js'
import { isClientComponent } from '../utils/patterns.js'

export const missingLoadingStateRule: Rule = {
  id: 'missing-loading-state',
  name: 'Missing Loading State',
  description: 'Detects client components with useEffect+fetch but no loading state',
  category: 'reliability',
  severity: 'info',
  fileExtensions: ['tsx', 'jsx'],

  check(file: FileContext, _project: ProjectContext): Finding[] {
    if (!isClientComponent(file.content)) return []

    const content = file.content

    // Must have useEffect
    if (!/\buseEffect\s*\(/.test(content)) return []

    // Must have fetch or async data loading inside
    const hasFetch = /\bfetch\s*\(/.test(content) ||
      /\baxios\b/.test(content) ||
      /\.get\s*\(/.test(content) ||
      /\.post\s*\(/.test(content)
    if (!hasFetch) return []

    // Check for loading state
    const hasLoadingState = /\b(?:loading|isLoading|pending|isPending|isFetching)\b/.test(content) ||
      /useState\s*<?\s*boolean\s*>?\s*\(\s*(?:true|false)\s*\)/.test(content) ||
      /\bSkeleton\b/.test(content) ||
      /\bSpinner\b/.test(content) ||
      /\buseSWR\b/.test(content) ||
      /\buseQuery\b/.test(content)

    if (hasLoadingState) return []

    // Find the useEffect line for reporting
    for (let i = 0; i < file.lines.length; i++) {
      if (/\buseEffect\s*\(/.test(file.lines[i])) {
        return [{
          ruleId: 'missing-loading-state',
          file: file.relativePath,
          line: i + 1,
          column: 1,
          message: 'useEffect with fetch but no loading/pending state — users see empty content during load',
          severity: 'info',
          category: 'reliability',
          fix: 'Add a loading state: const [loading, setLoading] = useState(true) and show a spinner/skeleton while loading',
        }]
      }
    }

    return []
  },
}
