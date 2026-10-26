import type { Rule, Finding, FileContext, ProjectContext } from '../types.js'
import { isCommentLine } from '../utils/patterns.js'
import { walkAST, subtreeContains } from '../utils/ast.js'
import type { Node, CallExpression, MemberExpression } from '@babel/types'

// Sanitizer calls: DOMPurify.sanitize() (any receiver, e.g. purify or DOMPurify(window)),
// sanitize-html's sanitizeHtml(), and js-xss's xss() / filterXSS()
const SANITIZER_NAME = /^(?:sanitize\w*|xss|filterXSS)$/i
const SANITIZER_CALL_TEXT = /^\s*(?:await\s+)?(?:[\w$.]*\.sanitize|sanitize\w*|xss|filterXSS)\s*\(/i

/** Is `node` a sanitizer call, possibly awaited or cast: `DOMPurify.sanitize(html) as string` */
function isSanitizerCall(node: Node): boolean {
  if (node.type === 'AwaitExpression') return isSanitizerCall(node.argument)
  if (node.type === 'TSAsExpression' || node.type === 'TSSatisfiesExpression' || node.type === 'TSNonNullExpression') {
    return isSanitizerCall(node.expression)
  }
  if (node.type !== 'CallExpression' && node.type !== 'OptionalCallExpression') return false
  const callee = node.callee
  if (callee.type === 'MemberExpression' || callee.type === 'OptionalMemberExpression') {
    return callee.property.type === 'Identifier' && callee.property.name === 'sanitize'
  }
  return callee.type === 'Identifier' && SANITIZER_NAME.test(callee.name)
}

/** Does `node` contain a JSON.stringify call (the JSON-LD pattern)? */
function containsJsonStringify(node: Node): boolean {
  return subtreeContains(node, (n: Node) => {
    if (n.type !== 'CallExpression') return false
    const call = n as CallExpression
    if (call.callee.type === 'MemberExpression') {
      const mem = call.callee as MemberExpression
      return mem.object.type === 'Identifier' && mem.object.name === 'JSON' &&
             mem.property.type === 'Identifier' && mem.property.name === 'stringify'
    }
    return false
  })
}

/**
 * Is the HTML in `value` sanitized: a sanitizer call, or a variable initialized from one
 * (`const clean = DOMPurify.sanitize(html)`). `value` is an innerHTML right-hand side or
 * a dangerouslySetInnerHTML value, whose `__html` is what gets checked.
 */
function isSanitized(value: Node, sanitizedNames: Set<string>): boolean {
  if (value.type === 'JSXExpressionContainer') return isSanitized(value.expression as Node, sanitizedNames)
  if (value.type === 'ObjectExpression') {
    const html = value.properties.find(p => p.type === 'ObjectProperty' &&
      ((p.key.type === 'Identifier' && p.key.name === '__html') || (p.key.type === 'StringLiteral' && p.key.value === '__html')))
    return html?.type === 'ObjectProperty' && isSanitized(html.value as Node, sanitizedNames)
  }
  if (value.type === 'Identifier') return sanitizedNames.has(value.name)
  return isSanitizerCall(value)
}

export const unsafeHtmlRule: Rule = {
  id: 'unsafe-html',
  name: 'Unsafe HTML Rendering',
  description: 'Detects dangerouslySetInnerHTML and other XSS vectors in JSX/DOM code',
  category: 'security',
  severity: 'critical',
  fileExtensions: ['ts', 'tsx', 'js', 'jsx'],

  check(file: FileContext, _project: ProjectContext): Finding[] {
    const findings: Finding[] = []

    // AST path
    if (file.ast) {
      try {
        // Variables holding sanitized HTML: const clean = DOMPurify.sanitize(html)
        const sanitizedNames = new Set<string>()
        walkAST(file.ast.program, (node: Node) => {
          if (node.type === 'VariableDeclarator' && node.id.type === 'Identifier' && node.init &&
              subtreeContains(node.init, isSanitizerCall)) {
            sanitizedNames.add(node.id.name)
          }
        })

        walkAST(file.ast.program, (node: Node) => {
          // dangerouslySetInnerHTML in JSX
          if (node.type === 'JSXAttribute') {
            const attr = node as any
            if (attr.name?.type === 'JSXIdentifier' && attr.name.name === 'dangerouslySetInnerHTML' && attr.loc) {
              // JSON.stringify in value → safe (JSON-LD pattern); sanitized → its own fix
              if (attr.value && (containsJsonStringify(attr.value) || isSanitized(attr.value, sanitizedNames))) return

              const line = attr.loc.start.line
              findings.push({
                ruleId: 'unsafe-html',
                file: file.relativePath,
                line,
                column: file.lines[line - 1].indexOf('dangerouslySetInnerHTML') + 1,
                message: 'dangerouslySetInnerHTML is an XSS risk — sanitize with DOMPurify or similar',
                severity: 'critical',
                category: 'security',
                fix: 'Sanitize HTML with DOMPurify before rendering: DOMPurify.sanitize(html)',
              })
            }
          }

          // dangerouslySetInnerHTML in object literal (e.g. const props = { dangerouslySetInnerHTML: ... })
          if (node.type === 'ObjectProperty') {
            const prop = node as any
            if (
              prop.key?.type === 'Identifier' && prop.key.name === 'dangerouslySetInnerHTML' &&
              prop.loc
            ) {
              if (prop.value && (containsJsonStringify(prop.value) || isSanitized(prop.value, sanitizedNames))) return

              const line = prop.loc.start.line
              findings.push({
                ruleId: 'unsafe-html',
                file: file.relativePath,
                line,
                column: file.lines[line - 1].indexOf('dangerouslySetInnerHTML') + 1,
                message: 'dangerouslySetInnerHTML is an XSS risk — sanitize with DOMPurify or similar',
                severity: 'critical',
                category: 'security',
                fix: 'Sanitize HTML with DOMPurify before rendering: DOMPurify.sanitize(html)',
              })
            }
          }

          // .innerHTML = assignment
          if (node.type === 'AssignmentExpression') {
            const assign = node as any
            if (
              assign.left?.type === 'MemberExpression' &&
              assign.left.property?.type === 'Identifier' &&
              assign.left.property.name === 'innerHTML' &&
              assign.loc
            ) {
              if (isSanitized(assign.right, sanitizedNames)) return

              const line = assign.loc.start.line
              findings.push({
                ruleId: 'unsafe-html',
                file: file.relativePath,
                line,
                column: file.lines[line - 1].indexOf('.innerHTML') + 1,
                message: 'Direct innerHTML assignment is an XSS risk',
                severity: 'critical',
                category: 'security',
                fix: 'Sanitize HTML with DOMPurify before rendering: DOMPurify.sanitize(html)',
              })
            }
          }
        })
        return findings
      } catch {
        // AST walk failed, fall through to regex
      }
    }

    // Regex fallback
    for (let i = 0; i < file.lines.length; i++) {
      if (isCommentLine(file.lines, i, file.commentMap)) continue

      const line = file.lines[i]

      if (/dangerouslySetInnerHTML\s*=/.test(line) || /dangerouslySetInnerHTML\s*:/.test(line)) {
        const context: string[] = [line]
        for (let j = 1; j <= 2 && i + j < file.lines.length; j++) {
          const nextLine = file.lines[i + j]
          if (/^\s*<[^/]|^\s*(const|let|var|return|export|import)\s/.test(nextLine)) break
          context.push(nextLine)
        }
        const expr = context.join(' ')
        if (/__html\s*:\s*JSON\.stringify/.test(expr)) continue
        const html = /__html\s*:/.exec(expr)
        if (html && SANITIZER_CALL_TEXT.test(expr.slice(html.index + html[0].length))) continue

        findings.push({
          ruleId: 'unsafe-html',
          file: file.relativePath,
          line: i + 1,
          column: line.indexOf('dangerouslySetInnerHTML') + 1,
          message: 'dangerouslySetInnerHTML is an XSS risk — sanitize with DOMPurify or similar',
          severity: 'critical',
          category: 'security',
          fix: 'Sanitize HTML with DOMPurify before rendering: DOMPurify.sanitize(html)',
        })
      }

      const innerHtml = /\w\.innerHTML\s*=/.exec(line)
      if (innerHtml && !SANITIZER_CALL_TEXT.test(line.slice(innerHtml.index + innerHtml[0].length))) {
        findings.push({
          ruleId: 'unsafe-html',
          file: file.relativePath,
          line: i + 1,
          column: line.indexOf('.innerHTML') + 1,
          message: 'Direct innerHTML assignment is an XSS risk',
          severity: 'critical',
          category: 'security',
          fix: 'Sanitize HTML with DOMPurify before rendering: DOMPurify.sanitize(html)',
        })
      }
    }

    return findings
  },
}
