import type { Rule, Finding, FileContext, ProjectContext } from '../types.js'
import { isApiRoute } from '../utils/patterns.js'

export const errorHandlingRule: Rule = {
  id: 'error-handling',
  name: 'Missing Error Handling',
  description: 'Detects API routes without try/catch',
  category: 'reliability',
  severity: 'warning',
  fileExtensions: ['ts', 'tsx', 'js', 'jsx'],

  check(file: FileContext, _project: ProjectContext): Finding[] {
    if (!isApiRoute(file.relativePath)) return []

    // Framework serve() patterns handle errors internally
    const hasFrameworkServe = /\bserve\s*\(/.test(file.content)
      || /createTRPCHandle/.test(file.content)
      || /fetchRequestHandler/.test(file.content)

    const hasTryCatch = /try\s*\{/.test(file.content)

    // Additional error handling patterns
    const hasCatchChain = /\.catch\s*\(/.test(file.content)
    const hasOnError = /onError\s*[:(]/.test(file.content)
    const hasNextResponseError = /NextResponse\.json\s*\([^)]*(?:error|status:\s*[45]\d{2})/.test(file.content)

    if (hasTryCatch || hasFrameworkServe || hasCatchChain || hasOnError || hasNextResponseError) return []

    let handlerLine = 1
    for (let i = 0; i < file.lines.length; i++) {
      if (/export\s+(async\s+)?function\s+(GET|POST|PUT|PATCH|DELETE|handler)/i.test(file.lines[i])) {
        handlerLine = i + 1
        break
      }
    }

    return [{
      ruleId: 'error-handling',
      file: file.relativePath,
      line: handlerLine,
      column: 1,
      message: 'API route handler has no try/catch block',
      severity: 'warning',
      category: 'reliability',
      fix: 'Wrap the handler body in try/catch and return appropriate error responses',
    }]
  },
}
