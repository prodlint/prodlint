# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/).

## [Unreleased]

### Fixed
- **0.10.2's first release run didn't reach the MCP registry.** It registered the server
  seconds after `npm publish`, while npm was still processing the new version. The
  release workflow now waits until npm serves the version and retries the registry, and
  a run that failed after npm can be resumed for its tag.

## [0.10.2] - 2026-10-26

### Fixed
- **0.10.1 never reached npm or the MCP registry.** The release workflow passed its
  tarball to `npm publish` as `release/prodlint-0.10.1.tgz`, which npm read as the GitHub
  repo `release/prodlint-0.10.1.tgz`. It now passes `./release/...`. 0.10.2 ships
  everything listed under 0.10.1 below.

### Changed
- Dependencies refreshed to clear all 13 `npm audit` findings (`npm audit`: 0
  vulnerabilities): `@modelcontextprotocol/sdk` 1.32.2, `zod` 4.6.7, transitive
  dependencies of the SDK and the build tools, and vitest 3 → 5 (dev-only).
- CI runs the test suite on Node 22 and 24, since vitest 5 needs Node 22.12 or later.
  Node 18 and 20, which prodlint still supports at runtime, build and self-scan.

## [0.10.1] - 2026-10-25

_Tagged but never published: the release workflow failed before `npm publish`
succeeded, so 0.10.1 is not on npm or the MCP registry, and the GitHub Action's
`v0.10.1` tag runs a version that doesn't exist. Use 0.10.2 (or the Action's `v1`)._

### Security
- **`--web` and the MCP `scan-web` tool could be pointed at private hosts.** The guard
  only compared the hostname string, so IPv4-mapped IPv6 (`[::ffff:127.0.0.1]`,
  `[::ffff:169.254.169.254]`), NAT64, `localhost.`, `*.localhost` and hostnames that
  resolve to private addresses all got through, and redirects were followed before the
  final URL was checked. Every resolved address is now checked at connect time (which
  also covers DNS rebinding), and redirects are followed by hand with each hop re-checked.
- **The GitHub Action always ran `prodlint@latest`**, so pinning the action to a tag or
  commit SHA didn't pin the scanner that ran in your CI. Each action release now runs its
  matching prodlint version, and `setup-node` and `sticky-pull-request-comment` are
  pinned by commit SHA.
- **PR comment markdown injection.** A crafted import name or file path in a pull request
  could add headings, @-mentions or HTML to the bot's comment: newlines weren't stripped,
  and bash quoting had dropped the backslash from the escaper. The comment is now built by
  `scripts/action-comment.cjs`, which flattens untrusted text to one line and renders it
  as inline code.
- **Release workflow split by privilege.** `npm ci` and the test suite ran in the same job
  that held the npm publishing (OIDC) token and repo write access. They now run in a
  read-only `build` job; publishing only sees the packed tarballs, and npm is pinned
  instead of `@latest`.

### Fixed
- **`--web` refused legitimate sites whose names start with "fc" or "fd"** (fdic.gov,
  fcc.gov, fd.io) as private hosts. The IPv6 unique-local check ran against every
  hostname, not just IP literals.
- **`--web` could hang indefinitely.** The request timeout was cleared before the body was
  read, so a server that trickled its response stalled the scan, or an MCP tool call,
  forever. One deadline now covers connect, redirects and body, and bodies are capped at 5 MB.

### Changed
- The GitHub Action runs on Node 22 (Node 20 is end-of-life).
- The Action's PR comment shows finding messages as inline code.
- `--web` fetches the homepage once instead of twice.

## [0.10.0] - 2026-08-09

### Fixed
- **`prodlint-mcp` served a months-old scanner.** The launcher package was published
  once as 0.3.1 depending on `prodlint@^0.3.1`, a range that capped installs at 0.3.x.
  Since the documented MCP setup was `npx -y prodlint-mcp`, everyone following the docs
  ran a February build. The launcher now lives in `packages/prodlint-mcp`, is versioned
  in lockstep with the scanner, and publishes from the same release workflow.
- **`server.json` built an invalid command.** It passed `prodlint-mcp` as a
  `packageArgument`, but those are arguments to the *server*, not the runtime — producing
  `npx prodlint prodlint-mcp`, i.e. the CLI trying to scan a directory named
  `prodlint-mcp`. The package identifier now points at the launcher.
- **False-positive `hallucinated-imports` in nested packages.** `buildProjectContext`
  only merged nested manifests when a `workspaces` field declared them, so a plain
  nested package had every import flagged critical. Nested manifests are now always
  collected (node_modules excluded, unparseable files skipped). **Scan results may
  change**: projects with non-workspace subpackages will lose spurious criticals.

### Changed
- MCP setup docs now use `npx -y -p prodlint prodlint-mcp`, which resolves the server
  straight from the scanner package.
- Releases publish via **npm trusted publishing (OIDC)** with provenance attestation —
  no `NPM_TOKEN`. The MCP registry publish is automated the same way. Previously no
  published version carried provenance, because the release workflow had never
  succeeded.
- Dependencies updated to clear all advisories (`npm audit`: 0 vulnerabilities).
- Dropped the `@rollup/rollup-win32-x64-msvc` pin; rollup declares its own platform
  bindings at matching versions, and the explicit pin forced a version mismatch.

### Added
- `scripts/verify-release.cjs` — validates version and `mcpName`/`server.json`
  consistency; runs in CI on every PR and before publish.
- `scripts/sync-versions.cjs` — wired to the `version` lifecycle hook so
  `npm version <bump>` propagates every hardcoded version string in the repo.
- 5 tests covering nested-package dependency discovery (623 total).

## [0.9.5] - 2026-06-29

### Changed
- MCP registry namespace moved from the personal `io.github.Anthony-Marcovecchio/prodlint`
  to the org `io.github.prodlint/prodlint`.

## [0.9.4] - 2026-06-29

### Added
- Secrets detection expanded from 12 to 24 patterns: Anthropic (`sk-ant-api`/`admin`),
  Google API keys and OAuth, Slack tokens and webhooks, GitLab, npm, Hugging Face,
  Groq, Supabase `sb_secret_`, PEM private keys, and database connection strings.

## [0.9.3] - 2026-06-29

### Changed
- Dependency security fixes.

### Added
- `npm run audit:supply-chain` — flags non-npmjs registry URLs and missing integrity
  hashes in the lockfile.

## [0.9.2] - 2026-02-27

### Added
- **`--sarif`** flag — SARIF 2.1.0 output for GitHub Code Scanning integration
- **`--summary`** flag — quick pass/fail verdict with top 3 critical/warning findings
- **`--profile <name>`** flag — presets: `startup` (criticals only), `balanced` (warnings+), `strict` (all)
- **`--baseline <file>`** flag — only show findings not present in a saved baseline
- **`--baseline-save <file>`** flag — save current findings as a baseline snapshot
- `reportSummary()` and `reportSarif()` exported from programmatic API
- MCP `scan` tool now includes fix hints in output
- 17 new tests: 10 reporter unit tests + 7 CLI integration tests (597 total)

## [0.9.1] - 2026-02-26

### Changed
- Improved detection for secrets, env fallbacks, and `console.log`.

## [0.9.0] - 2026-02-21

### Added
- **Fix hints on all 52 rules** — every finding now includes an actionable `fix` field with remediation guidance
- CLA (Contributor License Agreement)

### Changed
- `cors-config`: wildcard origin (`*`) combined with `credentials: true` escalated to critical severity
- `missing-abort-controller`: now detects axios calls without timeout configuration
- CI hardening and dependency updates
- MCP server path boundary validation strengthened

## [0.8.1] - 2026-02-21

### Fixed
- `hydration-mismatch`: reduced false positives
- `dead-exports`: reduced false positives

## [0.8.0] - 2026-02-20

### Added
- **Site Score** (`--web` flag) — scan any deployed website for AI agent-readiness, 14 checks scored 0-100
- Checks: robots.txt AI directives, llms.txt, ai.txt, TDMRep, A2A AgentCard, WebMCP tools, HTTP Signatures (RFC 9421), AI-Disclosure header, Content-Usage directives, structured data, OpenGraph, sitemap, page speed
- `npx prodlint --web example.com` and `--web --json` for JSON output
- `secrets` rule: OpenAI API key detection
- Pretty terminal report for site score results (`reportWebPretty`)
- Site Score grades: A+ (95-100) through F (0-29)

## [0.7.1] - 2026-02-20

### Fixed
- CI: suppress `eval-injection` self-detection in rule source (failing since v0.6.0)
- `shallow-catch`: single-line catch bodies (`catch { toast.error(...) }`) no longer falsely flagged as empty

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
