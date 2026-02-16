import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

export function getVersion(): string {
  try {
    // Try relative to the built file location
    const dir = dirname(fileURLToPath(import.meta.url))
    const pkg = JSON.parse(
      readFileSync(resolve(dir, '..', 'package.json'), 'utf-8'),
    )
    return pkg.version ?? '0.0.0'
  } catch {
    return '0.0.0'
  }
}
