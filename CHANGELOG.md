# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/).

## [0.2.2] - 2026-02-16

### Changed
- Set homepage to prodlint.com
- Expand npm keywords for better discoverability (cursor, copilot, cli, scanner)
- Exclude source maps from npm package (tarball 65KB → ~35KB)
- Add GitHub Action, MCP server, and example output to README
- Add SECURITY.md, CODE_OF_CONDUCT.md, CHANGELOG.md, PR template

## [0.2.1] - 2026-02-15

### Security
- Fix GitHub Action script injection via `${{ inputs }}` interpolation
- Fix symlink traversal allowing reads outside project root
- Fix markdown injection in PR comments via file paths
- Fix GITHUB_OUTPUT injection via unsanitized score values
- Sanitize error output to prevent stack trace leakage
- Add path containment check using realpath

### Fixed
- Add `zod` as explicit dependency (was phantom dependency via MCP SDK)
- Handle `\r`-only line endings correctly
- Use `mktemp` for temp files in GitHub Action

## [0.2.0] - 2026-02-15

### Added
- MCP server (`prodlint-mcp`) for Cursor, Claude Code, Windsurf
- GitHub Action with PR comments, threshold enforcement, and score output
- `unsafe-html` rule (dangerouslySetInnerHTML, innerHTML)
- `sql-injection` rule (template literal SQL queries)
- `// prodlint-disable` and `// prodlint-disable-next-line` suppression
- Block comment awareness across all rules
- Middleware auth detection (Clerk, NextAuth, Supabase)
- TypeScript path alias support
- Route exemptions (auth, webhook, health, cron)
- Programmatic API (`import { scan } from 'prodlint'`)

## [0.1.0] - 2026-02-15

### Added
- Initial release
- 9 rules: secrets, hallucinated-imports, error-handling, input-validation, rate-limiting, env-exposure, auth-checks, cors-config, ai-smells
- CLI with `--json`, `--ignore`, `--help`, `--version`
- 0-100 scoring across 4 categories
- Pretty terminal output with colored bar charts
