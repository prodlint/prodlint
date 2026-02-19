import type { Rule, Finding, FileContext, ProjectContext } from '../types.js'
import { isCommentLine } from '../utils/patterns.js'
import { walkAST, subtreeContains } from '../utils/ast.js'
import type { Node, CallExpression, MemberExpression } from '@babel/types'

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
        walkAST(file.ast.program, (node: Node) => {
          // dangerouslySetInnerHTML in JSX
          if (node.type === 'JSXAttribute') {
            const attr = node as any
            if (attr.name?.type === 'JSXIdentifier' && attr.name.name === 'dangerouslySetInnerHTML' && attr.loc) {
              // Check if value subtree contains JSON.stringify call
              if (attr.value && subtreeContains(attr.value, (n: Node) => {
                if (n.type !== 'CallExpression') return false
                const call = n as CallExpression
                if (call.callee.type === 'MemberExpression') {
                  const mem = call.callee as MemberExpression
                  return mem.object.type === 'Identifier' && mem.object.name === 'JSON' &&
                         mem.property.type === 'Identifier' && mem.property.name === 'stringify'
                }
                return false
              })) {
                return // JSON.stringify in value → safe (JSON-LD pattern)
              }

              const line = attr.loc.start.line
              findings.push({
                ruleId: 'unsafe-html',
                file: file.relativePath,
                line,
                column: file.lines[line - 1].indexOf('dangerouslySetInnerHTML') + 1,
                message: 'dangerouslySetInnerHTML is an XSS risk — sanitize with DOMPurify or similar',
                severity: 'critical',
                category: 'security',
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
              // Check if value subtree contains JSON.stringify
              if (prop.value && subtreeContains(prop.value, (n: Node) => {
                if (n.type !== 'CallExpression') return false
                const call = n as CallExpression
                if (call.callee.type === 'MemberExpression') {
                  const mem = call.callee as MemberExpression
                  return mem.object.type === 'Identifier' && mem.object.name === 'JSON' &&
                         mem.property.type === 'Identifier' && mem.property.name === 'stringify'
                }
                return false
              })) {
                return
              }

              const line = prop.loc.start.line
              findings.push({
                ruleId: 'unsafe-html',
                file: file.relativePath,
                line,
                column: file.lines[line - 1].indexOf('dangerouslySetInnerHTML') + 1,
                message: 'dangerouslySetInnerHTML is an XSS risk — sanitize with DOMPurify or similar',
                severity: 'critical',
                category: 'security',
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
              const line = assign.loc.start.line
              findings.push({
                ruleId: 'unsafe-html',
                file: file.relativePath,
                line,
                column: file.lines[line - 1].indexOf('.innerHTML') + 1,
                message: 'Direct innerHTML assignment is an XSS risk',
                severity: 'critical',
                category: 'security',
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

        findings.push({
          ruleId: 'unsafe-html',
          file: file.relativePath,
          line: i + 1,
          column: line.indexOf('dangerouslySetInnerHTML') + 1,
          message: 'dangerouslySetInnerHTML is an XSS risk — sanitize with DOMPurify or similar',
          severity: 'critical',
          category: 'security',
        })
      }

      if (/\w\.innerHTML\s*=/.test(line)) {
        findings.push({
          ruleId: 'unsafe-html',
          file: file.relativePath,
          line: i + 1,
          column: line.indexOf('.innerHTML') + 1,
          message: 'Direct innerHTML assignment is an XSS risk',
          severity: 'critical',
          category: 'security',
        })
      }
    }

    return findings
  },
}
