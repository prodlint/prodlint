import { describe, it, expect } from 'vitest'
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

const require = createRequire(import.meta.url)
const ROOT = join(__dirname, '..')
const { releaseNotes, moveUnreleased } = require(join(ROOT, 'scripts', 'release-notes.cjs')) as {
  releaseNotes: (changelog: string, version: string) => string
  moveUnreleased: (changelog: string, version: string, date: string) => string
}

const CHANGELOG = `# Changelog

## [Unreleased]

### Fixed

- Something new

## [1.2.10] - 2026-02-02

### Added

- Ten

## [1.2.1] - 2026-01-01

- One
`

describe('releaseNotes', () => {
  it('returns one section, without its heading or the next one', () => {
    expect(releaseNotes(CHANGELOG, '1.2.10')).toBe('### Added\n\n- Ten')
  })

  it('reads the last section to the end of the file', () => {
    expect(releaseNotes(CHANGELOG, '1.2.1')).toBe('- One')
  })

  it('reads [Unreleased] the same way', () => {
    expect(releaseNotes(CHANGELOG, 'Unreleased')).toBe('### Fixed\n\n- Something new')
  })

  it('is empty for a version with no section, or nothing in it', () => {
    expect(releaseNotes(CHANGELOG, '1.2')).toBe('')
    expect(releaseNotes(CHANGELOG, '9.9.9')).toBe('')
    expect(releaseNotes('## [Unreleased]\n\n## [1.0.0] - 2026-01-01\n\n- One\n', 'Unreleased')).toBe('')
  })

  it('reads a CRLF checkout', () => {
    expect(releaseNotes(CHANGELOG.replace(/\n/g, '\r\n'), '1.2.10')).toBe('### Added\n\n- Ten')
  })
})

describe('moveUnreleased', () => {
  it('puts the entries under the new version and leaves [Unreleased] empty above it', () => {
    const moved = moveUnreleased(CHANGELOG, '1.3.0', '2026-03-03')
    expect(moved).toContain('## [Unreleased]\n\n## [1.3.0] - 2026-03-03\n\n### Fixed\n\n- Something new\n\n## [1.2.10]')
    expect(releaseNotes(moved, 'Unreleased')).toBe('')
    expect(releaseNotes(moved, '1.3.0')).toBe('### Fixed\n\n- Something new')
  })

  it('finds the heading in a CRLF checkout', () => {
    const moved = moveUnreleased(CHANGELOG.replace(/\n/g, '\r\n'), '1.3.0', '2026-03-03')
    expect(releaseNotes(moved, '1.3.0')).toBe('### Fixed\n\n- Something new')
  })

  it('changes nothing when there is no [Unreleased] heading', () => {
    expect(moveUnreleased('# Changelog\n\n## [1.0.0]\n', '1.3.0', '2026-03-03')).toBe('# Changelog\n\n## [1.0.0]\n')
  })
})

// What `npm version` and release.yml run, on a copy of this repo's real files: a heading or an
// anchor that moved fails here, on the PR that moved it, instead of in the middle of a release.
describe('cutting a release', () => {
  const FILES = [
    'scripts/release-notes.cjs',
    'scripts/sync-versions.cjs',
    'scripts/verify-release.cjs',
    'package.json',
    'server.json',
    'packages/prodlint-mcp/package.json',
    'README.md',
    'tests/reporter.test.ts',
    'action.yml',
    'CHANGELOG.md',
  ]
  const VERSION = '99.0.0'

  function inCopy(run: (dir: string) => void) {
    const dir = mkdtempSync(join(tmpdir(), 'prodlint-release-'))
    try {
      for (const file of FILES) {
        mkdirSync(dirname(join(dir, file)), { recursive: true })
        cpSync(join(ROOT, file), join(dir, file))
      }
      const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
      writeFileSync(join(dir, 'package.json'), JSON.stringify({ ...pkg, version: VERSION }, null, 2))
      run(dir)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }

  function node(dir: string, script: string, ...args: string[]) {
    const env = { ...process.env, npm_lifecycle_event: '' }
    return spawnSync(process.execPath, [join(dir, 'scripts', script), ...args], { cwd: dir, encoding: 'utf8', env })
  }

  function editChangelog(dir: string, edit: (text: string) => string) {
    const path = join(dir, 'CHANGELOG.md')
    writeFileSync(path, edit(readFileSync(path, 'utf8').replace(/\r\n/g, '\n')))
  }

  /** The changelog as it is on the morning of a release that has something in it */
  const withEntry = (text: string) => text.replace('## [Unreleased]\n', '## [Unreleased]\n\n### Fixed\n\n- A test entry\n')

  it('takes the [Unreleased] entries through to the GitHub Release notes', () => {
    inCopy(dir => {
      editChangelog(dir, withEntry)

      const sync = node(dir, 'sync-versions.cjs')
      expect(sync.stderr).toBe('')
      expect(sync.status).toBe(0)

      const verify = node(dir, 'verify-release.cjs', `v${VERSION}`)
      expect(verify.stdout + verify.stderr).not.toContain('FAIL')
      expect(verify.status).toBe(0)

      const notes = node(dir, 'release-notes.cjs', VERSION)
      expect(notes.status).toBe(0)
      expect(notes.stdout).toContain('### Fixed\n\n- A test entry\n')
      expect(notes.stdout).not.toContain('## [')

      expect(readFileSync(join(dir, 'CHANGELOG.md'), 'utf8').replace(/\r\n/g, '\n'))
        .toMatch(/^## \[Unreleased\]\n\n## \[99\.0\.0\] - \d{4}-\d{2}-\d{2}\n\n### Fixed\n\n- A test entry\n/m)
      expect(node(dir, 'release-notes.cjs', 'Unreleased').status).toBe(1)
    })
  })

  it('leaves a second sync alone, because the version already has its section', () => {
    inCopy(dir => {
      editChangelog(dir, withEntry)
      expect(node(dir, 'sync-versions.cjs').status).toBe(0)
      const before = readFileSync(join(dir, 'CHANGELOG.md'), 'utf8')
      expect(node(dir, 'sync-versions.cjs').status).toBe(0)
      expect(readFileSync(join(dir, 'CHANGELOG.md'), 'utf8')).toBe(before)
    })
  })

  it('refuses to sync a version with nothing to say', () => {
    inCopy(dir => {
      editChangelog(dir, text => text.replace(/## \[Unreleased\]\n[\s\S]*?(?=## \[\d)/, '## [Unreleased]\n\n'))
      const sync = node(dir, 'sync-versions.cjs')
      expect(sync.status).toBe(1)
      expect(sync.stderr).toContain('[Unreleased]')
    })
  })

  it('stops a release whose version has no notes before anything is published', () => {
    inCopy(dir => {
      editChangelog(dir, withEntry)
      expect(node(dir, 'sync-versions.cjs').status).toBe(0)
      editChangelog(dir, text => text.replace(`## [${VERSION}]`, '## [98.0.0]'))
      const verify = node(dir, 'verify-release.cjs', `v${VERSION}`)
      expect(verify.status).toBe(1)
      expect(verify.stderr).toContain('CHANGELOG.md')
    })
  })

  it('exits 1 for a version with no notes, which fails the release job', () => {
    inCopy(dir => {
      const notes = node(dir, 'release-notes.cjs', '98.0.0')
      expect(notes.status).toBe(1)
      expect(notes.stdout).toBe('')
      expect(notes.stderr).toContain('98.0.0')
    })
  })

  it('is what npm version and the release job actually run', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
    expect(pkg.scripts.preversion).toBe('node scripts/release-notes.cjs Unreleased')
    expect(pkg.scripts.version).toBe('node scripts/sync-versions.cjs')

    const release = readFileSync(join(ROOT, '.github', 'workflows', 'release.yml'), 'utf8').replace(/\r\n/g, '\n')
    const job = release.slice(release.indexOf('\n  github-release:'))
    expect(job).toContain('node scripts/release-notes.cjs "${RELEASE_TAG#v}" > release-notes.md')
    // The notes step reads a file and needs no token: only the step after it gets one.
    const notesStep = job.slice(job.indexOf('release-notes.cjs'), job.indexOf('- name: Create the GitHub Release'))
    expect(notesStep).not.toContain('GH_TOKEN')
    expect(job).toContain('--notes-file release-notes.md')
  })
})
