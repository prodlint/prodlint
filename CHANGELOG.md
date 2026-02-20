# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/).

## [0.7.0] - 2026-02-19

### Changed
- Migrated 9 rules from regex-only to AST analysis with regex fallback: `shallow-catch`, `open-redirect`, `ssrf-risk`, `path-traversal`, `jwt-no-expiry`, `unsafe-html`, `hydration-mismatch`, `missing-transaction`, `leaked-env-in-logs`
- `hallucinated-imports`: AST-first code path eliminates template literal false positives; regex fallback when AST unavailable
- `getImportSources()` return type changed from `string[]` to `{ source: string, line: number }[]`; now handles dynamic `import()` calls
- Total AST-based rules: 12 of 52

### Added
- **Monorepo workspace support**: `buildProjectContext()` detects npm/yarn `workspaces` field and `pnpm-workspace.yaml`, merges workspace package names and deps into `declaredDependencies` — eliminates ~20k false positives in monorepos
- `shallow-catch`: recognizes toast notifications (`toast.error()`, `toast({...}`), Sentry (`captureException()`, `captureMessage()`), structured loggers (`logger.error()`, `log.error()`), error utilities (`handleError()`, `reportError()`, etc.), Express middleware (`next(err)`), and Next.js `notFound()` as proper error handling
- `isScriptFile()`: now matches standalone script filenames (`seed.ts`, `migrate.ts`, `setup.ts`, `deploy.ts`, etc.) regardless of directory
- 4 new AST helpers: `isUserInputNode()`, `isStaticString()`, `findUseEffectRanges()`, `subtreeContains()`
- 37 new tests (562 total)

### Fixed
- `hallucinated-imports`: import-like text inside template literals no longer flagged (AST path)
- `shallow-catch`: single-line catch bodies (`catch { toast.error(...) }`) no longer incorrectly detected as empty
- `shallow-catch`: `}` inside template literal expressions no longer breaks catch body detection
- `open-redirect`: `redirect("/dashboard")` no longer flagged (static string is safe)
- `ssrf-risk`: `fetch("https://api.example.com")` no longer flagged; "allowlist" in comments no longer suppresses direct user input findings
- `path-traversal`: "sanitize" in comments no longer suppresses direct user input findings
- `jwt-no-expiry`: multi-line options beyond 5-line window now correctly detected
- `unsafe-html`: multi-line `JSON.stringify` beyond 2-line window now detected; `dangerouslySetInnerHTML` in object literals now detected
- `hydration-mismatch`: complex nested useEffect callbacks now precisely excluded via AST ranges
- `missing-transaction`: writes in separate functions no longer flagged (scoped by enclosing function)
- `leaked-env-in-logs`: `console.log("process.env.FOO is set")` no longer flagged (string literal, not actual env access)

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
