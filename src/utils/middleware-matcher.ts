import type { Node } from '@babel/types'
import { parseFile } from './ast.js'

// Next.js runs middleware only on the paths its `export const config = { matcher }` matches.
// It reads the matcher statically: a string, or an array of strings and { source } objects.

/**
 * Whether the matcher in middleware `content` keeps the middleware off /api routes. False
 * when there's no matcher (the middleware runs on every path) and when it can't be read.
 */
export function matcherExcludesApi(content: string, fileName: string): boolean {
  const sources = matcherSources(content, fileName)
  if (!sources || sources.length === 0) return false
  return sources.every(source => {
    const matcher = compile(source)
    return matcher !== null && !matcher.patterns.some(namesApi) && !apiPaths(matcher.literals).some(path => matcher.regexp.test(path))
  })
}

/**
 * Whether the matcher in middleware `content` keeps the middleware on /api alone, off the
 * pages outside it: the mirror of matcherExcludesApi. False when there's no matcher and when
 * it can't be read.
 */
export function matcherExcludesPages(content: string, fileName: string): boolean {
  const sources = matcherSources(content, fileName)
  if (!sources || sources.length === 0) return false
  return sources.every(source => {
    const matcher = compile(source)
    return matcher !== null && underApi(matcher.tokens)
  })
}

// Whether every path a source matches is /api or under it. Only a literal start pins that:
// /api/:path* and /api/(.*) do, but /api(.*) also matches /apikeys, and a source that
// starts with a pattern, like /(api|trpc)(.*), counts as reaching pages.
function underApi(tokens: (string | Key)[]): boolean {
  const [head, ...rest] = tokens
  if (typeof head !== 'string') return false
  if (head.startsWith('/api/')) return true
  if (head !== '/api') return false
  // After /api the path must end or go on with a /. A token that can match nothing, like
  // the :id? in /api/:id?.json, leaves that to the next one.
  for (const token of rest) {
    const start = typeof token === 'string' ? token : token.pattern ? prefixOf(token) : token.prefix + token.suffix
    if (!start.startsWith('/')) return false
    if (typeof token === 'string' || (token.modifier !== '?' && token.modifier !== '*')) return true
  }
  return true
}

// API paths to try a matcher on: two samples, and paths built from the source's literal
// parts, which a parameter before them can put under /api (/:path*/_get matches
// /api/x/_get). A bare /api isn't one: dub's /((?!api/|_next/).*) skips every API route
// but still matches /api itself.
function apiPaths(literals: string[]): string[] {
  const paths = ['/api/x', '/api/x/y']
  for (const literal of literals) {
    for (const head of ['', '/api', '/api/x']) {
      for (const tail of ['', '/x']) paths.push(head + literal + tail)
    }
  }
  return paths.filter(path => path.startsWith('/api/'))
}

// The matcher's sources, as Next.js's extractExportedConstValue would read them. undefined
// when there's no matcher, null when it isn't a literal.
function matcherSources(content: string, fileName: string): string[] | null | undefined {
  const ast = parseFile(content, fileName)
  if (!ast) return null
  for (const st of ast.program.body) {
    if (st.type !== 'ExportNamedDeclaration' || st.declaration?.type !== 'VariableDeclaration') continue
    if (st.declaration.kind !== 'const') continue
    for (const d of st.declaration.declarations) {
      if (d.id.type !== 'Identifier' || d.id.name !== 'config' || !d.init) continue
      const config = unwrap(d.init)
      if (config.type !== 'ObjectExpression') return null
      if (config.properties.some(p => p.type !== 'ObjectProperty')) return null
      const matcher = property(config, 'matcher')
      if (!matcher) return undefined
      const values = matcher.type === 'ArrayExpression' ? matcher.elements : [matcher]
      const sources: string[] = []
      for (const value of values) {
        const element = value ? unwrap(value) : null
        const source = element?.type === 'ObjectExpression' ? property(element, 'source') : element
        const text = source ? literal(source) : null
        if (text === null) return null
        sources.push(text)
      }
      return sources
    }
  }
  return undefined
}

function unwrap(node: Node): Node {
  while (node.type === 'TSSatisfiesExpression' || node.type === 'TSAsExpression') node = node.expression
  return node
}

// The last property with this name wins, as in JS
function property(object: Node, name: string): Node | undefined {
  if (object.type !== 'ObjectExpression') return undefined
  let value: Node | undefined
  for (const p of object.properties) {
    if (p.type !== 'ObjectProperty' || p.computed) continue
    const key = p.key.type === 'Identifier' ? p.key.name : p.key.type === 'StringLiteral' ? p.key.value : null
    if (key === name) value = unwrap(p.value)
  }
  return value
}

function literal(node: Node): string | null {
  if (node.type === 'StringLiteral') return node.value
  if (node.type === 'TemplateLiteral' && node.expressions.length === 0) return node.quasis[0].value.cooked ?? null
  return null
}

// A regex group that names api outside a negative lookahead may reach part of /api, like
// /(dashboard|api/admin)/:path*, which the sample paths miss
function namesApi(pattern: string): boolean {
  let kept = ''
  const negative: boolean[] = [] // per open group: is it (?!…) or (?<!…)
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]
    const skipping = negative.includes(true)
    if (c === '\\') {
      if (!skipping) kept += pattern.slice(i, i + 2)
      i++
    } else if (c === '(') {
      negative.push(pattern.startsWith('(?!', i) || pattern.startsWith('(?<!', i))
      if (!skipping) kept += c
    } else if (c === ')') {
      negative.pop()
      if (!negative.includes(true)) kept += c
    } else if (!skipping) {
      kept += c
    }
  }
  return /\bapi\b/i.test(kept)
}

// path-to-regexp 6.3.0, which Next.js compiles matcher sources with: its lexer, parser and
// tokensToRegexp with the default options. Next.js gives a repeated token with no prefix
// or suffix a / prefix, and matches case-sensitively. null for a source Next.js rejects.
const DELIMITER = '/#?'
const PREFIXES = './'

interface Key { prefix: string; suffix: string; pattern: string; modifier: string }

const escape = (s: string) => s.replace(/([.+*?=^!:${}()[\]|/\\])/g, '\\$1')

// A parameter's prefix, with the / Next.js gives a repeat that has no prefix or suffix
const prefixOf = (token: Key) =>
  (token.modifier === '*' || token.modifier === '+') && !token.prefix && !token.suffix ? '/' : token.prefix

function lex(source: string): { type: string; value: string }[] {
  const tokens: { type: string; value: string }[] = []
  let i = 0
  while (i < source.length) {
    const c = source[i]
    if (c === '*' || c === '+' || c === '?') {
      tokens.push({ type: 'MODIFIER', value: source[i++] })
    } else if (c === '\\') {
      tokens.push({ type: 'ESCAPED_CHAR', value: source[i + 1] })
      i += 2
    } else if (c === '{' || c === '}') {
      tokens.push({ type: c === '{' ? 'OPEN' : 'CLOSE', value: source[i++] })
    } else if (c === ':') {
      const name = /^\w+/.exec(source.slice(i + 1))?.[0]
      if (!name) throw new TypeError(`Missing parameter name at ${i}`)
      tokens.push({ type: 'NAME', value: name })
      i += 1 + name.length
    } else if (c === '(') {
      let depth = 1
      let pattern = ''
      let j = i + 1
      if (source[j] === '?') throw new TypeError(`Pattern cannot start with "?" at ${j}`)
      while (j < source.length) {
        if (source[j] === '\\') {
          pattern += source[j++] + source[j++]
          continue
        }
        if (source[j] === ')') {
          if (--depth === 0) {
            j++
            break
          }
        } else if (source[j] === '(') {
          depth++
          if (source[j + 1] !== '?') throw new TypeError(`Capturing groups are not allowed at ${j}`)
        }
        pattern += source[j++]
      }
      if (depth) throw new TypeError(`Unbalanced pattern at ${i}`)
      if (!pattern) throw new TypeError(`Missing pattern at ${i}`)
      tokens.push({ type: 'PATTERN', value: pattern })
      i = j
    } else {
      tokens.push({ type: 'CHAR', value: source[i++] })
    }
  }
  tokens.push({ type: 'END', value: '' })
  return tokens
}

function parse(source: string): (string | Key)[] {
  const tokens = lex(source)
  const result: (string | Key)[] = []
  let i = 0
  let path = ''
  const tryConsume = (type: string) => (i < tokens.length && tokens[i].type === type ? tokens[i++].value : undefined)
  const mustConsume = (type: string) => {
    const value = tryConsume(type)
    if (value === undefined) throw new TypeError(`Unexpected ${tokens[i].type}, expected ${type}`)
    return value
  }
  const consumeText = () => {
    let text = ''
    let value: string | undefined
    while ((value = tryConsume('CHAR') || tryConsume('ESCAPED_CHAR'))) text += value
    return text
  }
  const safePattern = (prefix: string) => {
    const prev = result[result.length - 1]
    const prevText = prefix || (typeof prev === 'string' ? prev : '')
    if (prev && !prevText) throw new TypeError('Must have text between two parameters')
    if (!prevText || [...DELIMITER].some(c => prevText.includes(c))) return `[^${escape(DELIMITER)}]+?`
    return `(?:(?!${escape(prevText)})[^${escape(DELIMITER)}])+?`
  }

  while (i < tokens.length) {
    const char = tryConsume('CHAR')
    const name = tryConsume('NAME')
    const pattern = tryConsume('PATTERN')
    if (name || pattern) {
      let prefix = char || ''
      if (!PREFIXES.includes(prefix)) {
        path += prefix
        prefix = ''
      }
      if (path) {
        result.push(path)
        path = ''
      }
      result.push({ prefix, suffix: '', pattern: pattern || safePattern(prefix), modifier: tryConsume('MODIFIER') || '' })
      continue
    }
    const value = char || tryConsume('ESCAPED_CHAR')
    if (value) {
      path += value
      continue
    }
    if (path) {
      result.push(path)
      path = ''
    }
    if (tryConsume('OPEN')) {
      const prefix = consumeText()
      const name = tryConsume('NAME') || ''
      const pattern = tryConsume('PATTERN') || ''
      const suffix = consumeText()
      mustConsume('CLOSE')
      result.push({ prefix, suffix, pattern: name && !pattern ? safePattern(prefix) : pattern, modifier: tryConsume('MODIFIER') || '' })
      continue
    }
    mustConsume('END')
  }
  return result
}

function compile(source: string): { regexp: RegExp; tokens: (string | Key)[]; literals: string[]; patterns: string[] } | null {
  if (!source.startsWith('/')) return null
  try {
    const tokens = parse(source)
    let route = '^'
    for (const token of tokens) {
      if (typeof token === 'string') {
        route += escape(token)
        continue
      }
      if (!token.pattern) {
        route += `(?:${escape(token.prefix)}${escape(token.suffix)})${token.modifier}`
        continue
      }
      const repeat = token.modifier === '*' || token.modifier === '+'
      const prefix = escape(prefixOf(token))
      const suffix = escape(token.suffix)
      if (!prefix && !suffix) {
        route += `(${token.pattern})${token.modifier}`
      } else if (repeat) {
        route += `(?:${prefix}((?:${token.pattern})(?:${suffix}${prefix}(?:${token.pattern}))*)${suffix})${token.modifier === '*' ? '?' : ''}`
      } else {
        route += `(?:${prefix}(${token.pattern})${suffix})${token.modifier}`
      }
    }
    return {
      regexp: new RegExp(`${route}[${escape(DELIMITER)}]?$`),
      tokens,
      literals: tokens.filter((token): token is string => typeof token === 'string'),
      patterns: tokens.flatMap(token => (typeof token === 'string' ? [] : [token.pattern])),
    }
  } catch {
    return null
  }
}
