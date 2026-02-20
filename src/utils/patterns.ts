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
 * Check if a file path looks like a test/spec file
 */
export function isTestFile(relativePath: string): boolean {
  return /\.(test|spec)\.[jt]sx?$/.test(relativePath) ||
    /(?:^|\/)__tests__\//.test(relativePath) ||
    /(?:^|\/)tests?\//.test(relativePath) ||
    /(?:^|\/)fixtures?\//.test(relativePath) ||
    /(?:^|\/)mocks?\//.test(relativePath)
}

/**
 * Check if a file path looks like a script (not application code)
 */
export function isScriptFile(relativePath: string): boolean {
  if (/(?:^|\/)scripts?\//.test(relativePath)) return true
  // Common standalone script filenames
  const name = relativePath.split('/').pop() ?? ''
  const base = name.replace(/\.[^.]+$/, '')
  return /^(seed|migrate|setup|bootstrap|generate|codegen|sync|deploy|cleanup|reset)$/.test(base)
}

/**
 * Check if a file path looks like a config file
 */
export function isConfigFile(relativePath: string): boolean {
  const name = relativePath.split('/').pop() ?? ''
  return /\.config\.[jt]sx?$/.test(name) ||
    /\.config\.(mjs|cjs)$/.test(name) ||
    name.startsWith('.env') ||
    name === 'next.config.js' ||
    name === 'next.config.ts' ||
    name === 'next.config.mjs' ||
    name === 'tailwind.config.ts' ||
    name === 'tailwind.config.js' ||
    name === 'postcss.config.js' ||
    name === 'postcss.config.mjs' ||
    name === 'tsconfig.json' ||
    name === 'jest.config.ts' ||
    name === 'jest.config.js' ||
    name === 'vitest.config.ts' ||
    name === 'vitest.config.mts'
}

/**
 * Find loop bodies in source lines via brace counting.
 * Returns array of { loopLine, bodyStart, bodyEnd } (0-indexed).
 */
export function findLoopBodies(
  lines: string[],
  commentMap: boolean[],
): { loopLine: number; bodyStart: number; bodyEnd: number }[] {
  const results: { loopLine: number; bodyStart: number; bodyEnd: number }[] = []

  for (let i = 0; i < lines.length; i++) {
    if (commentMap[i]) continue
    const trimmed = lines[i].trim()
    // Match for/forEach/map/while/for...of/for...in
    const isLoop = /^\s*(for\s*\(|for\s+await\s*\(|while\s*\()/.test(lines[i]) ||
      /\.(forEach|map)\s*\(/.test(trimmed)

    if (!isLoop) continue

    // Find the opening brace
    let braceCount = 0
    let bodyStart = -1
    let foundOpen = false

    for (let j = i; j < lines.length; j++) {
      if (commentMap[j]) continue
      const line = lines[j]
      for (let k = 0; k < line.length; k++) {
        const ch = line[k]
        if (ch === '{') {
          if (!foundOpen) {
            bodyStart = j
            foundOpen = true
          }
          braceCount++
        } else if (ch === '}') {
          braceCount--
          if (foundOpen && braceCount === 0) {
            results.push({ loopLine: i, bodyStart, bodyEnd: j })
            // Jump outer loop past the end of this loop body
            i = j
            // Use a label-free approach: set j to lines.length to break inner
            j = lines.length
            break
          }
        }
      }
    }
  }

  return results
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
