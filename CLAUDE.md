# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run build        # tsup → dist/cli.js, dist/mcp.js, dist/index.js
npm run dev          # tsup --watch
npm run test         # vitest run (618 tests)
npm run test:watch   # vitest
npm run lint         # self-scan via node dist/cli.js .
```

Run a single test file: `npx vitest run tests/rules/secrets.test.ts`

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

**v0.7.0 AST migration**: 9 rules upgraded from regex to AST analysis with regex fallback: `shallow-catch`, `open-redirect`, `ssrf-risk`, `path-traversal`, `jwt-no-expiry`, `unsafe-html`, `hydration-mismatch`, `missing-transaction`, `leaked-env-in-logs`. Total AST-based rules: 12 (including `sql-injection`, `no-n-plus-one`, `hallucinated-imports`).

### Two-Phase Scanning

- **Phase 1**: Per-file rules — `rule.check(file, project)` called for each file
- **Phase 2**: Project-level rules — `rule.checkProject(allFiles, project)` called once with all FileContexts

Project-level rules: `codebase-consistency`, `dead-exports`, `phantom-dependency`

### Shared Utilities

**`src/utils/patterns.ts`** — regex-based helpers:
- `isApiRoute(path)`, `isClientComponent(content)`, `isServerComponent(content)`
- `buildCommentMap(lines)` / `isCommentLine()` — comment handling
- `isLineSuppressed()` — prodlint-disable support
- `isTestFile(path)`, `isScriptFile(path)` (matches `scripts/` dir + standalone names like `seed.ts`, `migrate.ts`), `isConfigFile(path)`
- `findLoopBodies(lines, commentMap)` — loop body extraction via brace counting (fallback)

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

**`src/utils/frameworks.ts`** — framework detection + whitelists:
- `DEPENDENCY_TO_FRAMEWORK` — maps npm packages to framework identifiers
- `FRAMEWORK_SAFE_METHODS` — methods safe per framework (e.g., Prisma `.contains()`)
- `isFrameworkSafeMethod(method, frameworks)` — whitelist check
- `SQL_SAFE_ORMS`, `RATE_LIMIT_FRAMEWORKS` — categorized framework sets

### Key Patterns

- **Comment skipping**: All rules use `file.commentMap` (precomputed block comment map) + `isCommentLine()` to skip comments
- **Suppression**: `// prodlint-disable <ruleId>` (file-level) and `// prodlint-disable-next-line <ruleId>` (line-level), checked in `src/utils/patterns.ts`
- **Context-aware severity**: Some rules downgrade severity based on project context (e.g., auth-checks → info if middleware detected)
- **Threshold aggregation**: Rules like ai-smells count occurrences across a file, report once at line 1 if threshold exceeded
- **Deduplication**: hallucinated-imports uses a `seen` Set to avoid reporting the same missing package twice per file
- **Monorepo support**: `buildProjectContext()` detects workspaces (npm/yarn `workspaces` field + `pnpm-workspace.yaml`) and merges workspace package names + deps into `declaredDependencies`
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

Composite action: installs Node 20, runs `npx prodlint --json`, parses JSON, posts PR comment via `marocchino/sticky-pull-request-comment@v2`, fails if score < threshold. Sanitizes markdown output to prevent injection.

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

`npm version` fires the `version` lifecycle hook, which runs `scripts/sync-versions.cjs`
to propagate the new version into `server.json` (both fields),
`packages/prodlint-mcp/package.json` (its `version` and its `^` range on `prodlint`),
the `README.md` sample output, and the `tests/reporter.test.ts` fixture — then stages
them into the version commit. The script **fails loudly** if a text anchor no longer
matches exactly once, rather than silently skipping a file.

Pushing the `vX.Y.Z` tag runs `.github/workflows/release.yml`, which verifies metadata,
builds, tests, self-scans, publishes **both** `prodlint` and the `prodlint-mcp` launcher
to npm with provenance, publishes to the **MCP registry**, then force-updates the
rolling `v1` tag.

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

Tip: sweep the website repo with `grep -rn "<old-version>"` (excluding
node_modules/dist/package-lock/CHANGELOG). `npm run verify:release` checks this repo's
set at any time; CI runs it on every PR.

**`master` branch protection requires a check named exactly `build`.** The CI matrix
emits `build-and-test (18|20|22)`, so `ci.yml` carries a dependent aggregator job named
`build` purely to satisfy it. Removing that job silently makes every PR unmergeable
without an admin override.

**Do not re-add `@rollup/rollup-win32-x64-msvc` as an explicit dependency.** It was a
workaround for an `os=linux` line in the machine's global `~/.npmrc`, which made npm skip
win32 native bindings on Windows. That line is gone; rollup declares all 26 platform
bindings itself at its exact version, and pinning one separately reintroduces version skew.

### npm Package

`files` field includes only `dist/**/*.js`, `dist/**/*.d.ts`, and `action.yml`. Source maps are built but excluded from the published tarball (~22 KB).
