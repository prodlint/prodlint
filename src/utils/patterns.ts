/**
 * Check if a file path looks like a Next.js API route
 */
export function isApiRoute(relativePath: string): boolean {
  // Next.js App Router: app/**/route.ts
  if (/app\/.*route\.(ts|js|tsx|jsx)$/.test(relativePath)) return true
  // Next.js Pages Router: pages/api/**
  if (/pages\/api\//.test(relativePath)) return true
  return false
}

/**
 * Check if a file is a React client component (has "use client" directive)
 */
export function isClientComponent(content: string): boolean {
  // Must be at the very top (possibly after comments/whitespace)
  const firstLines = content.slice(0, 500)
  return /^(['"])use client\1/m.test(firstLines)
}

/**
 * Check if a file is a React server component (default in App Router)
 */
export function isServerComponent(content: string): boolean {
  return !isClientComponent(content)
}

/**
 * Pre-compute which lines are inside block comments.
 * Returns a boolean array where true = line is inside a block comment.
 */
export function buildCommentMap(lines: string[]): boolean[] {
  const map = new Array<boolean>(lines.length).fill(false)
  let inBlock = false

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]

    if (inBlock) {
      map[i] = true
      if (line.includes('*/')) {
        inBlock = false
      }
      continue
    }

    // Check for block comment start (not preceded by code on the same line that matters)
    const trimmed = line.trim()
    if (trimmed.startsWith('/*')) {
      map[i] = true
      if (!trimmed.includes('*/')) {
        inBlock = true
      }
      continue
    }

    // Inline /* ... */ on a line with code — don't mark the whole line
    // But a line that's ONLY a mid-block comment continuation (starts with *)
    if (trimmed.startsWith('*')) {
      // Could be JSDoc or block comment continuation
      map[i] = true
    }
  }

  return map
}

/**
 * Check if a line is a comment (single-line or inside block comment)
 */
export function isCommentLine(lines: string[], lineIndex: number, commentMap: boolean[]): boolean {
  if (commentMap[lineIndex]) return true
  const trimmed = lines[lineIndex]?.trim() ?? ''
  return trimmed.startsWith('//')
}

/**
 * Check if line is suppressed by a prodlint-disable comment
 */
export function isLineSuppressed(
  lines: string[],
  lineIndex: number,
  ruleId: string,
): boolean {
  // Check file-level disable
  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed === '' || trimmed.startsWith('//') || trimmed.startsWith('/*')) {
      const match = trimmed.match(/prodlint-disable\s+(.+)/)
      if (match) {
        const ids = match[1].split(/[\s,]+/).filter(Boolean)
        if (ids.includes(ruleId)) return true
      }
      continue
    }
    break // Stop at first non-comment, non-empty line
  }

  // Check line-level disable (previous line)
  if (lineIndex > 0) {
    const prevLine = lines[lineIndex - 1].trim()
    const match = prevLine.match(/prodlint-disable-next-line\s+(.+)/)
    if (match) {
      const ids = match[1].split(/[\s,]+/).filter(Boolean)
      if (ids.includes(ruleId)) return true
    }
  }

  return false
}

/**
 * Known Node.js built-in modules
 */
export const NODE_BUILTINS = new Set([
  'assert', 'async_hooks', 'buffer', 'child_process', 'cluster',
  'console', 'constants', 'crypto', 'dgram', 'diagnostics_channel',
  'dns', 'domain', 'events', 'fs', 'http', 'http2', 'https',
  'inspector', 'module', 'net', 'os', 'path', 'perf_hooks',
  'process', 'punycode', 'querystring', 'readline', 'repl',
  'stream', 'string_decoder', 'sys', 'timers', 'tls', 'trace_events',
  'tty', 'url', 'util', 'v8', 'vm', 'wasi', 'worker_threads', 'zlib',
  // node: prefixed are handled separately
])
