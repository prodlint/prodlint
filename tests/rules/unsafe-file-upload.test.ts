import { describe, it, expect } from 'vitest'
import { unsafeFileUploadRule } from '../../src/rules/unsafe-file-upload.js'
import { makeFile, makeProject } from '../helpers.js'

const project = makeProject()

describe('unsafe-file-upload rule', () => {
  it('detects file upload without validation', () => {
    const file = makeFile(`export async function POST(req) {
  const data = await req.formData()
  const file = data.get('file')
  await saveFile(file)
}`, { relativePath: 'app/api/upload/route.ts' })
    const findings = unsafeFileUploadRule.check(file, project)
    expect(findings).toHaveLength(1)
    expect(findings[0].ruleId).toBe('unsafe-file-upload')
  })

  it('allows upload with type validation', () => {
    const file = makeFile(`export async function POST(req) {
  const data = await req.formData()
  const file = data.get('file')
  if (!file.type.startsWith('image/')) throw new Error('Invalid type')
  await saveFile(file)
}`, { relativePath: 'app/api/upload/route.ts' })
    const findings = unsafeFileUploadRule.check(file, project)
    expect(findings).toHaveLength(0)
  })

  it('allows upload with size check', () => {
    const file = makeFile(`export async function POST(req) {
  const data = await req.formData()
  const file = data.get('file')
  if (file.size > maxFileSize) throw new Error('Too large')
}`, { relativePath: 'app/api/upload/route.ts' })
    const findings = unsafeFileUploadRule.check(file, project)
    expect(findings).toHaveLength(0)
  })

  it('ignores non-upload routes', () => {
    const file = makeFile(`export async function POST(req) {
  const body = await req.json()
}`, { relativePath: 'app/api/users/route.ts' })
    const findings = unsafeFileUploadRule.check(file, project)
    expect(findings).toHaveLength(0)
  })

  it('detects in server actions', () => {
    const file = makeFile(`'use server'
export async function uploadFile(formData) {
  const file = formData.get('image')
  await storage.upload(file)
}`, { relativePath: 'actions/upload.ts' })
    const findings = unsafeFileUploadRule.check(file, project)
    expect(findings).toHaveLength(1)
  })
})
