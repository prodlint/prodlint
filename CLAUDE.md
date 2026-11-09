# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run build        # tsup → dist/cli.js, dist/mcp.js, dist/index.js
npm run dev          # tsup --watch
npm run test         # vitest run (vitest 5 needs Node >= 22.12)
npm run test:watch   # vitest
npm run lint         # self-scan via node dist/cli.js .
```

Run a single test file: `npx vitest run tests/rules/secrets.test.ts`

`tests/cli-features.test.ts` and `tests/mcp-server.test.ts` run the built `dist/`
(the MCP one talks JSON-RPC to `dist/mcp.js` over stdio), so build before testing.

## Architecture

Prodlint is a production readiness tool for vibe-coded apps — a static analysis CLI that checks whether AI-generated JS/TS code is ready to ship. Three entry points built by tsup:

- **`src/cli.ts`** → `dist/cli.js` (shebang) — CLI via `npx prodlint`
- **`src/mcp.ts`** → `dist/mcp.js` (shebang) — MCP server via `npx prodlint-mcp`
- **`src/index.ts`** → `dist/index.js` + `.d.ts` — public API (`import { scan } from 'prodlint'`)

### Scan Flow

```
cli.ts (parseArgs) → scanner.ts (scan)
  → file-walker.ts (fast-glob + default ignores)
  → readFileContext() per file (content, lines, commentMap, AST)
  → buildProjectContext() once (package.json deps, workspace deps, tsconfig paths, middleware, framework detection)
  → for each file × each rule: rule.check(file, project) → Finding[]
  → isLineSuppressed() filters suppressed findings
  → scorer.ts (per-rule caps + diminishing returns, overall = average)
  → reporter.ts (pretty terminal or JSON)
```

### Rule Interface

Each rule in `src/rules/` implements:

```typescript
{
  id, name, description, category, severity, fileExtensions,
  check(file: FileContext, project: ProjectContext): Finding[],
  checkProject?(files: FileContext[], project: ProjectContext): Finding[]  // optional, for cross-file analysis
}
```

Rules are registered in `src/rules/index.ts`. Currently 52 rules across all 4 categories (security: 27, reliability: 11, performance: 6, ai-quality: 8).

**v0.5.0 new rules**: `insecure-cookie` (security), `leaked-env-in-logs` (security), `insecure-random` (security), `next-server-action-validation` (security, critical), `missing-transaction` (reliability)

**v0.7.0 AST migration**: 9 rules upgraded from regex to AST analysis with regex fallback: `shallow-catch`, `open-redirect`, `ssrf-risk`, `path-traversal`, `jwt-no-expiry`, `unsafe-html`, `hydration-mismatch`, `missing-transaction`, `leaked-env-in-logs`. Total AST-based rules: 15 (including `sql-injection`, `no-n-plus-one` and `hallucinated-imports`, plus three migrated later: `redirect-in-try-catch`, `auth-checks` for route handler exports and their auth wrappers, and `server-action-auth` for the client each exported action is built on and what its calls are made on).

### Two-Phase Scanning

- **Phase 1**: Per-file rules — `rule.check(file, project)` called for each file
- **Phase 2**: Project-level rules — `rule.checkProject(allFiles, project)` called once with all FileContexts

Project-level rules: `codebase-consistency`, `dead-exports`, `phantom-dependency`, `supabase-missing-rls` (RLS is often enabled in a later migration than the `CREATE TABLE`). A phase-2 finding that points into a scanned file honors that file's `prodlint-disable` comments, like phase 1.

### Shared Utilities

**`src/utils/patterns.ts`** — regex-based helpers:
- `isApiRoute(path)`, `isClientComponent(content)`, `isServerComponent(content)`
- `buildCommentMap(lines)` / `isCommentLine()` — comment handling
- `isLineSuppressed()` — prodlint-disable support
- `isTestFile(path)`, `isScriptFile(path)` (matches `scripts/` dir + standalone names like `seed.ts`, `migrate.ts`), `isConfigFile(path)`
- `findLoopBodies(lines, commentMap)` — loop body extraction via brace counting (fallback)
- `blankOut(source, strings)` / `closingBrace(code, open)` — regex fallbacks: blank out comments (and string contents) keeping offsets, then match braces (`shallow-catch`, `redirect-in-try-catch`)
- `nameWords(name)`, `saysAuth(name)`, `saysNoAuth(name)` — whether a name or module path has an auth or session word ("Author" isn't one), or a word that says the opposite (`auth-checks`' wrappers, `server-action-auth`'s clients)

**`src/utils/ast.ts`** — Babel AST utilities (v0.4.0+, expanded v0.7.0):
- `parseFile(content, fileName)` — parses JS/TS/JSX/TSX into Babel AST, returns null on failure
- `walkAST(ast, visitor)` — simple recursive depth-first walker (no @babel/traverse dependency)
- `isTaggedTemplateSql(node)` — detects `sql\`...\`` and `Prisma.sql\`...\`` tags
- `findLoopsAST(ast)` — accurate loop body ranges using AST (replaces brace counting)
- `getImportSources(ast)` — extracts import/require/dynamic-import sources as `{ source, line }[]`
- `isUserInputNode(node)` — detects `req.query.x`, `searchParams.get()`, `formData.get()` (v0.7.0)
- `isStaticString(node)` — detects StringLiteral and zero-expression TemplateLiteral (v0.7.0)
- `findUseEffectRanges(ast)` — precise useEffect callback body line ranges (v0.7.0)
- `subtreeContains(node, predicate)` — recursive subtree search helper (v0.7.0)
- `unwrapExpression(node)` — strips `as`, `satisfies`, `!`, `<T>`, parentheses and `await`

**`src/utils/frameworks.ts`** — framework detection + whitelists:
- `DEPENDENCY_TO_FRAMEWORK` — maps npm packages to framework identifiers
- `FRAMEWORK_SAFE_METHODS` — methods safe per framework (e.g., Prisma `.contains()`)
- `isFrameworkSafeMethod(method, frameworks)` — whitelist check
- `SQL_SAFE_ORMS`, `RATE_LIMIT_FRAMEWORKS` — categorized framework sets

**`src/utils/middleware-matcher.ts`** — Next.js middleware `config.matcher`:
- `matcherExcludesApi(content, fileName)` — reads a literal `export const config = { matcher }` and compiles each source as Next.js does (a port of path-to-regexp 6.3.0). True only when no source can reach a path under /api; no matcher or an unreadable one is false. Sets `ProjectContext.authMiddlewareExcludesApi`, which auth-checks uses to stop downgrading `app/api/**` and `pages/api/**`
- `matcherExcludesPages(content, fileName)` — the mirror: true only when no source can reach a path outside /api, which only a literal start (`/api/…`) can pin; no matcher or an unreadable one is false. Sets `ProjectContext.authMiddlewareExcludesPages`, which server-action-auth uses to keep its warning, since an action is posted to the page that calls it

### Key Patterns

- **Comment skipping**: All rules use `file.commentMap` (precomputed block comment map) + `isCommentLine()` to skip comments
- **Suppression**: `// prodlint-disable <ruleId>` (file-level) and `// prodlint-disable-next-line <ruleId>` (line-level), checked in `src/utils/patterns.ts`
- **Context-aware severity**: Some rules downgrade severity based on project context (e.g., auth-checks and server-action-auth → info, not cleared, if auth middleware is detected)
- **Middleware detection**: `hasAuthMiddleware` / the middleware half of `hasRateLimiting` come from `middleware.(ts|js)` or Next.js 16's `proxy.(ts|js)`, at the scanned root or in `src/` only. A monorepo app's own middleware (`apps/web/proxy.ts`) isn't read, so it can't vouch for the rest of the repo. `authMiddlewareExcludesApi` and `authMiddlewareExcludesPages` come from the same files' `config.matcher`; when two of them do auth, both matchers must agree. `rateLimitsInMiddleware` is stricter than `hasRateLimiting`: a rate-limit call in the code, not a word in a comment or `throttle()`, and a matcher that reaches pages
- **Threshold aggregation**: Rules like ai-smells count occurrences across a file, report once at line 1 if threshold exceeded
- **Deduplication**: hallucinated-imports uses a `seen` Set to avoid reporting the same missing package twice per file
- **Monorepo support**: `buildProjectContext()` detects workspaces (npm/yarn `workspaces` field + `pnpm-workspace.yaml`) and merges workspace package names + deps into `declaredDependencies`
- **Import resolution (dead-exports)**: imports are resolved to the scanned modules they load (relative path, alias by path suffix, workspace package from the walked `package.json` names), and re-exports pass a use on. An import from a declared dependency, a Node built-in or a URL uses no project export; only an import that matches no scanned file still counts by name everywhere. Keep that fallback: it covers aliases and layouts the resolver can't follow
- **Action clients (server-action-auth)**: an exported action counts as checked when its builder chain says so, by the client's name (`authActionClient`, `protectedAction`, and `userActionClient` or `adminActionClient` as a whole name, so `withSupabaseAdmin` and `adminClient`, which are about a service-role client, stay out) or an auth `.use()`. An imported client is judged by its name alone; one defined in the same file is read, and its name counts only once it has a `.use()`. Each export counts on its own, so a plain function exported next to a checked action is still reported. A `.use()` that turns signed-in users away (`throwIfAuthenticated`, by the whole name) marks the action public by design and counts too. A helper in the file that only such actions can reach counts as their code (`helpersOf`); one an open export or the module itself reaches doesn't. A file Babel can't parse stays with the text check
- **Writes (server-action-auth)**: three tiers, in `readCalls`. (1) What's a write by itself: a method in `WRITE_METHOD`, a Firestore function or a SQL statement in one string, unless what it's called on stays local: a hash, a stream or AI state, the `set()` and `delete()` of a `Map`, `Headers` or `URLSearchParams` (a real `Response` has no `save()`), or a cookie, which changes only the caller's own browser. That's read from what the file binds the receiver to, so a name defined out of sight, or that also stands for something else, counts as a write: flagging one is the safe direction. `push()` counts only on a Firebase reference, a named event or a module-level array. (2) What only keeps a finding: the old text check (`WRITE_CALL`, `SQL_WORD`) finds what might be a write, and it stands unless every other call in the file is shown harmless (`isOutward`, `isHarmless`): a read by its first word, a question, the language's, the framework's or a query builder's own, a call from a package that only reads or builds, or a helper whose body is in the file. An HTTP method string or a command that writes keeps it too. None of these counts alone, and this tier can't add a finding, so it can afford to be broad: a name missing from its lists costs what the text check always did. Don't go back to listing write verbs here: a write can be called anything (`clearCart`, `transferFunds`). (3) Model calls get their own message, read per action through the file's own helpers (`reachesUnlimitedModel`), and a rate limit on that path clears them. Middleware that rate-limits (`ProjectContext.rateLimitsInMiddleware`) lowers them to info; a package in the dependencies (`hasRateLimiting`) says nothing about the action. The message says a write first, then what goes out and stays out (below), then a model call, then a helper named like a write, then what's kept; only a model call with nothing else is lowered by middleware. A call named like a read that also writes can still be lost
- **Outward writes (server-action-auth)**: what goes out and stays out counts by itself when the file shows it (`effectOf`, `outwardWrite`), read per action through the file's own helpers: a request (`fetch()`, `axios`, `ky`, `got`, a client the file makes of them), a file write from `fs`, mail, an AWS command that writes, a KV or bucket `put()`, `@vercel/blob`, or a helper imported from the project and named like a write (`deletePhoto`). Each `Effect` reads as a write (`writes: true`), not one (`false`, which neither counts nor keeps a finding: a GraphQL query, a token exchange, a captcha check, a login proxy, the caller's token in the request, a cached or read-named URL, analytics, a public form, mail to one fixed address, an account's own mail, a temp file, a log, a cache; a DELETE only by the caller's token, `carriesToken`, since its URL names what it removes, and never by a `credentials` option, since a server's request has none of the caller's cookies) or out of sight (`null`, which only keeps a finding: a request through an imported client, since 16 of the 28 read on a sample forward a token, and a helper it won't count, since `resetPassword()` is still a write). An action named for something public, or that calls `requireAdmin()` or a bare `getCurrentUser()` (`checksUser`, not `getAdmin()` or `ensureAdminInitialized()`), is left alone. `CHECKS_USER` reads how a name ends, so `checkUserInput()`, `ensureUserExists()` and `ensureUsersTable()` aren't checks. Making sure a user or a membership exists is about whoever it's handed (`OF_A_USER`): `ensureUser(authorId)` is an upsert. What a `require` or an `assert` is handed is a role, a client or the caller's id on a sample (`assertUser('SUPER_ADMIN')`, `requireUser(supabase)`), so those still count. What it keeps is left alone only if it's named for a login, a sign-up or a public form: `updatePassword` still keeps a finding. A `delete()` through a client the file shows is a write in tier (1), as it was, unless the caller's token goes with it. A value a helper returns reads as the caller's, so a request with a server's token from a helper isn't reported, and a helper that checks the user itself is: 4 of the 89 modules searched on a sample show a check. When tightening these, list every call in what it clears: `{ ...feature }` once read as a token, and `/capture` as analytics when it was a payment
- **Line/column numbering**: 1-indexed throughout

### Scoring (v0.5.0)

Per-category scoring with three protections against false-positive damage:
1. **Per-rule cap**: Max 1 critical, 2 warning, 3 info deductions per rule
2. **Adjusted deductions**: critical -8, warning -2, info -0.5
3. **Diminishing returns**: After 30 points deducted in a category, halved; after 50, quartered

Overall = **weighted** average: security 40%, reliability 30%, performance 15%, ai-quality 15%. Floor at 0.

### Finding Interface (v0.5.0)

`Finding` has an optional `fix?: string` field for actionable remediation hints. All 52 rules include fix suggestions (v0.9.1).

### CLI Flags

- `--json` — Output results as JSON (ScanResult object)
- `--sarif` — Output results as SARIF 2.1.0 (for GitHub Code Scanning)
- `--summary` — Quick pass/fail verdict with top 3 critical/warning findings
- `--min-severity <level>` — Filter findings to only show critical, warning, or info and above
- `--profile <name>` — Preset: `startup` (criticals only), `balanced` (warnings+), `strict` (all including info)
- `--baseline <file>` — Only show findings not present in the baseline file
- `--baseline-save <file>` — Save current findings as a baseline snapshot (for use with `--baseline`)
- `--ignore <pattern>` — Glob patterns to ignore (repeatable)
- `--quiet` — Suppress the README badge output
- `--web` — Run site score scan (14 AI agent checks)

### Exit Codes

- 0: no critical findings
- 1: critical findings exist
- 2: runtime error

### GitHub Action (`action.yml`)

Composite action: installs Node 22, runs `npx -y prodlint@<this release> --json`, parses JSON, posts PR comment via `marocchino/sticky-pull-request-comment`, then fails on critical findings (`fail-on-critical`, default `true`), on a score below `threshold`, or when the scan produced no result. Both third-party actions are SHA-pinned.

- **Pass/fail is decided by `scripts/action-check.cjs`**, which also writes the `score`/`critical` outputs. Tests: `tests/action-check.test.ts`.

- **The scanner version is pinned, never `@latest`.** `sync-versions.cjs` bumps the pin and `verify-release.cjs` fails on drift, so pinning the action (`@v1`, a tag, a SHA) pins the code that runs in users' CI.
- **The comment is built by `scripts/action-comment.cjs`**, not inline `node -e "..."` — bash's double-quote processing once silently stripped the escaper's backslash. File paths and messages come from the scanned repo: they're flattened to one line and rendered as inline code (no autolinks, @-mentions or HTML there). Tests: `tests/action-comment.test.ts`.

### Adding a New Rule

1. Create `src/rules/<rule-id>.ts` implementing the `Rule` interface
2. Add to the array in `src/rules/index.ts`
3. Create `tests/rules/<rule-id>.test.ts`
4. Run `npm test` and `npm run build`

### Version Bump Checklist

A release in this repo is two commands:

```bash
npm version patch    # or minor/major
git push --follow-tags
```

From a worktree or any branch but master, push with `git push origin HEAD:master --follow-tags`.
The push's "Bypassed rule violations" notice is normal. Redirect `npm version`'s output to a
file rather than piping it: a filter that exits early kills it mid-run.

`npm version` first runs `scripts/release-notes.cjs Unreleased` (`preversion`), which stops
the bump if `CHANGELOG.md` has nothing under `[Unreleased]`. Then it fires the `version`
lifecycle hook, which runs `scripts/sync-versions.cjs` to propagate the new version into
`server.json` (both fields), `packages/prodlint-mcp/package.json` (its `version` and its `^`
range on `prodlint`), the `README.md` sample output, the `tests/reporter.test.ts` fixture,
and the scanner pin in `action.yml`, and to move the `[Unreleased]` entries under the new
version's heading in `CHANGELOG.md` (don't move them by hand) — then stages them into the
version commit. The script **fails loudly** if a text anchor no longer matches exactly once,
rather than silently skipping a file. `tests/release-notes.test.ts` runs these scripts on a
copy of the repo, so a moved anchor fails its own PR instead of a release.

Pushing the `vX.Y.Z` tag runs `.github/workflows/release.yml`, which verifies metadata,
builds, tests, self-scans, publishes **both** `prodlint` and the `prodlint-mcp` launcher
to npm with provenance, publishes to the **MCP registry**, then force-updates the
rolling `v1` tag, and creates the GitHub Release from the version's CHANGELOG section.

It is four jobs, split by privilege — keep it that way:
- **`build`** (read-only token, no OIDC) runs everything that executes third-party code —
  `npm ci`, build, tests, self-scan — then `npm pack`s both packages into an artifact.
- **`publish`** (`id-token: write`) only downloads the tarballs and publishes them, plus
  the MCP registry step. Tarball publishes run no lifecycle scripts. npm is pinned, not `@latest`.
  It ends by waiting for npm to serve `prodlint`'s tarball, which can lag the version's listing
  by minutes, so `v1` never points at a scanner `npx` can't download yet.
- **`update-v1-tag`** (`contents: write`) runs nothing but git.
- **`github-release`** (`contents: write`) reads the notes with `scripts/release-notes.cjs`, in a
  step with no token, then runs nothing but `gh`. It's last, so a failure can't hurt a release
  that's already out, and `verify-release.cjs` checks the notes exist before anything publishes.
  A resume skips it if the Release exists.

**If a release run fails after npm** (MCP registry, `v1`), don't re-run it: a re-run
reuses the tagged commit's workflow file and retries the npm publishes, which npm refuses.
Resume it from master instead — the npm steps skip versions that are already published:

```bash
gh workflow run release.yml --ref master -f tag=vX.Y.Z
```

A resume only accepts the newest `vX.Y.Z` tag; resuming an older one (e.g. `v0.10.1`, which
never reached npm) would publish that old version and move `v1` backwards, so the workflow
refuses it. Only `vX.Y.Z` tags trigger a release; pushing `v1` by hand doesn't.

Every credential is OIDC — there is no `NPM_TOKEN` and no stored registry JWT:
- **npm**: trusted publishing. Both `prodlint` and `prodlint-mcp` have
  `prodlint/prodlint` + `release.yml` registered as a trusted publisher on npmjs.com.
- **MCP registry**: `mcp-publisher login github-oidc`. The pinned publisher tarball is
  SHA256-verified before it runs; bump `MCP_PUBLISHER_VERSION`/`MCP_PUBLISHER_SHA256`
  together (get the digest from the release asset's `digest` field).

**Still manual — the website repo only** (prodlint-website):
`app/components/animated-terminal.tsx`, `app/layout.tsx` JSON-LD `softwareVersion`,
`public/.well-known/agent-card.json` → `"version"`, and the sample output in
`app/blog/data.ts`. Note: `app/mcp/page.tsx` no longer carries a version string.

**Pushing the website repo doesn't deploy it**: Vercel's Hobby plan refuses push-triggered builds
from a private org repo, so its commit status goes red. Deployment in that repo's `CLAUDE.md`
gives the route that works, a Vercel connector deployment from the Git source. Check the live
`/.well-known/agent-card.json` afterwards.

Tip: sweep the website repo with `grep -rn "<old-version>"` (excluding
node_modules/dist/package-lock/CHANGELOG). `npm run verify:release` checks this repo's
set at any time; CI runs it on every PR.

**`master` branch protection requires a check named exactly `build`.** The CI matrices
emit `build-and-test (22|24)` and `build-and-scan (18|20)`, so `ci.yml` carries a
dependent aggregator job named `build` purely to satisfy it. Removing that job silently
makes every PR unmergeable without an admin override.

**CI runs the test suite on Node 22 and 24 only; 18 and 20 build and self-scan.** vitest 5
needs Node >= 22.12, but `package.json` `engines` still promises Node >= 18 at runtime, and
the `build-and-scan` legs keep that promise exercised. Keep them while `engines` says `>=18`.

**Do not re-add `@rollup/rollup-win32-x64-msvc` as an explicit dependency.** It was a
workaround for an `os=linux` line in the machine's global `~/.npmrc`, which made npm skip
win32 native bindings on Windows. That line is gone; rollup declares all 26 platform
bindings itself at its exact version, and pinning one separately reintroduces version skew.

### npm Package

`files` field includes only `dist/**/*.js`, `dist/**/*.d.ts`, and `action.yml`. Source maps are built but excluded from the published tarball (~22 KB).
