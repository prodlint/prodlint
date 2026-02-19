import type { Rule, Finding, FileContext, ProjectContext } from '../types.js'
import { isApiRoute, isTestFile } from '../utils/patterns.js'

const UPLOAD_PATTERNS = [
  /\.get\s*\(\s*['"`]file['"`]\s*\)/,
  /\.get\s*\(\s*['"`]image['"`]\s*\)/,
  /\.get\s*\(\s*['"`]upload['"`]\s*\)/,
  /\.get\s*\(\s*['"`]attachment['"`]\s*\)/,
  /\.get\s*\(\s*['"`]document['"`]\s*\)/,
  /\.get\s*\(\s*['"`]avatar['"`]\s*\)/,
  /\.get\s*\(\s*['"`]photo['"`]\s*\)/,
  /\.type\s*===?\s*['"`]file['"`]/,
  /req\.file\b/,
  /multer/i,
  /busboy/i,
  /formidable/i,
]

const VALIDATION_PATTERNS = [
  /\.type\b.*(?:image|video|audio|pdf|text)\//,
  /content-type/i,
  /mime/i,
  /\.size\s*[><!]/,
  /maxFileSize/i,
  /maxSize/i,
  /fileSizeLimit/i,
  /allowedTypes/i,
  /acceptedTypes/i,
  /fileFilter/i,
  /\.endsWith\s*\(\s*['"`]\./,
  /\.extension/i,
]

export const unsafeFileUploadRule: Rule = {
  id: 'unsafe-file-upload',
  name: 'Unsafe File Upload',
  description: 'Detects file upload handlers without type or size validation',
  category: 'security',
  severity: 'warning',
  fileExtensions: ['ts', 'tsx', 'js', 'jsx'],

  check(file: FileContext, _project: ProjectContext): Finding[] {
    if (isTestFile(file.relativePath)) return []
    if (!isApiRoute(file.relativePath) && !/['"]use server['"]/.test(file.content)) return []

    const hasUpload = UPLOAD_PATTERNS.some(p => p.test(file.content))
    if (!hasUpload) return []

    const hasValidation = VALIDATION_PATTERNS.some(p => p.test(file.content))
    if (hasValidation) return []

    let reportLine = 1
    for (let i = 0; i < file.lines.length; i++) {
      if (UPLOAD_PATTERNS.some(p => p.test(file.lines[i]))) {
        reportLine = i + 1
        break
      }
    }

    return [{
      ruleId: 'unsafe-file-upload',
      file: file.relativePath,
      line: reportLine,
      column: 1,
      message: 'File upload without type or size validation — accepts any file type and size',
      severity: 'warning',
      category: 'security',
      fix: 'Validate file type (check MIME type, not just extension) and enforce a size limit before processing',
    }]
  },
}
