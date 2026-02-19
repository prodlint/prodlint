import type { Rule, Finding, FileContext, ProjectContext } from '../types.js'
import { isCommentLine, isTestFile } from '../utils/patterns.js'
import { walkAST, isStaticString, isUserInputNode } from '../utils/ast.js'
import type { Node, CallExpression, MemberExpression } from '@babel/types'

const FS_WITH_USER_INPUT = [
  { pattern: /(?:readFile|readFileSync|createReadStream)\s*\(\s*(?:req|request)\.(?:query|body|params)/, msg: 'File read with user-controlled path — allows reading arbitrary files' },
  { pattern: /(?:readFile|readFileSync|createReadStream)\s*\(\s*(?:filePath|fileName|path|file|name)\s*[,)]/, msg: 'File read with potentially user-controlled path — validate before use' },
  { pattern: /(?:writeFile|writeFileSync|createWriteStream)\s*\(\s*(?:req|request)\.(?:query|body|params)/, msg: 'File write with user-controlled path — allows writing arbitrary files' },
  { pattern: /(?:unlink|unlinkSync|rm|rmSync)\s*\(\s*(?:req|request)\.(?:query|body|params)/, msg: 'File delete with user-controlled path — allows deleting arbitrary files' },
  { pattern: /path\.join\s*\([^)]*(?:req|request)\.(?:query|body|params)/, msg: 'path.join with user input — still vulnerable to traversal with ../' },
  { pattern: /\.sendFile\s*\(\s*(?:req|request)\.(?:query|body|params)/, msg: 'express.sendFile with user-controlled path — validate against a base directory' },
]

const SANITIZATION_PATTERNS = [
  /path\.resolve\s*\(.*\)\.startsWith/,
  /\.replace\s*\(\s*['"]\.\.['"],?\s*['"].*['"]\s*\)/,
  /\.includes\s*\(\s*['"]\.\.['"].*\)/,
  /normalize/,
  /sanitize/i,
  /realpath/,
]

const FS_FUNCTION_NAMES = new Set([
  'readFile', 'readFileSync', 'createReadStream',
  'writeFile', 'writeFileSync', 'createWriteStream',
  'unlink', 'unlinkSync', 'rm', 'rmSync',
])

const SUSPICIOUS_PATH_VARS = new Set([
  'filePath', 'fileName', 'path', 'file', 'name',
])

export const pathTraversalRule: Rule = {
  id: 'path-traversal',
  name: 'Path Traversal',
  description: 'Detects filesystem operations with user-controlled paths — allows reading/writing arbitrary files via ../ sequences',
  category: 'security',
  severity: 'critical',
  fileExtensions: ['ts', 'tsx', 'js', 'jsx'],

  check(file: FileContext, _project: ProjectContext): Finding[] {
    if (isTestFile(file.relativePath)) return []

    const findings: Finding[] = []

    // AST path: per-call arg checking, no file-wide escape hatch
    if (file.ast) {
      try {
        walkAST(file.ast.program, (node: Node) => {
          if (node.type !== 'CallExpression') return
          const call = node as CallExpression
          if (!call.loc) return

          let fnName: string | null = null

          // Direct call: readFile(x), writeFile(x), etc.
          if (call.callee.type === 'Identifier' && FS_FUNCTION_NAMES.has(call.callee.name)) {
            fnName = call.callee.name
          }

          // Member call: fs.readFile(x), path.join(x, y), res.sendFile(x)
          if (call.callee.type === 'MemberExpression') {
            const mem = call.callee as MemberExpression
            if (mem.property.type === 'Identifier') {
              if (FS_FUNCTION_NAMES.has(mem.property.name)) {
                fnName = mem.property.name
              }
              if (mem.property.name === 'join' && mem.object.type === 'Identifier' && mem.object.name === 'path') {
                fnName = 'path.join'
              }
              if (mem.property.name === 'sendFile') {
                fnName = 'sendFile'
              }
            }
          }

          if (!fnName) return

          // For path.join, check all args; for others, check first arg
          const argsToCheck = fnName === 'path.join' ? call.arguments : [call.arguments[0]]

          for (const arg of argsToCheck) {
            if (!arg) continue
            if (isStaticString(arg)) continue

            const lineNum = call.loc.start.line
            const col = call.loc.start.column + 1

            if (isUserInputNode(arg)) {
              const action = fnName.includes('write') || fnName.includes('Write') ? 'write' :
                             fnName.includes('unlink') || fnName === 'rm' || fnName === 'rmSync' ? 'delete' :
                             fnName === 'sendFile' ? 'send' : 'read'
              findings.push({
                ruleId: 'path-traversal',
                file: file.relativePath,
                line: lineNum,
                column: col,
                message: fnName === 'path.join'
                  ? 'path.join with user input — still vulnerable to traversal with ../'
                  : `File ${action} with user-controlled path — allows ${action === 'send' ? 'sending' : action + 'ing'} arbitrary files`,
                severity: 'critical',
                category: 'security',
                fix: 'Validate the resolved path starts with an expected base directory: path.resolve(base, input).startsWith(path.resolve(base))',
              })
              return
            }

            if (arg.type === 'Identifier' && SUSPICIOUS_PATH_VARS.has(arg.name)) {
              findings.push({
                ruleId: 'path-traversal',
                file: file.relativePath,
                line: lineNum,
                column: col,
                message: `File operation with potentially user-controlled path — validate before use`,
                severity: 'warning',
                category: 'security',
                fix: 'Validate the resolved path starts with an expected base directory: path.resolve(base, input).startsWith(path.resolve(base))',
              })
              return
            }
          }
        })
        return findings
      } catch {
        // AST walk failed, fall through to regex
      }
    }

    // Regex fallback (keeps file-wide sanitization escape hatch)
    const hasSanitization = SANITIZATION_PATTERNS.some(p => p.test(file.content))
    if (hasSanitization) return []

    for (let i = 0; i < file.lines.length; i++) {
      if (isCommentLine(file.lines, i, file.commentMap)) continue
      const line = file.lines[i]

      for (const { pattern, msg } of FS_WITH_USER_INPUT) {
        const match = pattern.exec(line)
        if (match) {
          const severity = /req|request/.test(match[0]) ? 'critical' : 'warning'
          findings.push({
            ruleId: 'path-traversal',
            file: file.relativePath,
            line: i + 1,
            column: match.index + 1,
            message: msg,
            severity: severity as 'critical' | 'warning',
            category: 'security',
            fix: 'Validate the resolved path starts with an expected base directory: path.resolve(base, input).startsWith(path.resolve(base))',
          })
          break
        }
      }
    }

    return findings
  },
}
