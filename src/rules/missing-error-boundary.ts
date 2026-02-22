import type { Rule, Finding, FileContext, ProjectContext } from '../types.js'

export const missingErrorBoundaryRule: Rule = {
  id: 'missing-error-boundary',
  name: 'Missing Error Boundary',
  description: 'Detects Next.js layout files without a matching error.tsx in the same directory',
  category: 'reliability',
  severity: 'info',
  fileExtensions: ['tsx', 'jsx', 'ts', 'js'],

  check(file: FileContext, project: ProjectContext): Finding[] {
    // Only check layout files inside app/ or src/app/ (not the root layout)
    const match = file.relativePath.match(/^((?:src\/)?app\/)(.+\/)layout\.(tsx?|jsx?)$/)
    if (!match) return []

    const dir = match[1] + match[2]

    // Check if error.tsx/error.jsx/error.ts/error.js exists in same directory
    const hasErrorBoundary = project.allFiles.some(f =>
      f.startsWith(dir) &&
      /^error\.(tsx?|jsx?)$/.test(f.slice(dir.length)),
    )

    if (hasErrorBoundary) return []

    return [{
      ruleId: 'missing-error-boundary',
      file: file.relativePath,
      line: 1,
      column: 1,
      message: `Layout without error.tsx — errors in ${dir} will bubble up to parent error boundary`,
      severity: 'info',
      category: 'reliability',
      fix: 'Add an error.tsx file in the same route segment to catch rendering errors',
    }]
  },
}
