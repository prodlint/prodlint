# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run build        # tsup → dist/cli.js, dist/mcp.js, dist/index.js
npm run dev          # tsup --watch
npm run test         # vitest run (562+ tests)
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

`Finding` now has an optional `fix?: string` field for actionable remediation hints. New rules include fix suggestions.

### CLI Flags (v0.5.0)

- `--min-severity <level>` — Filter findings to only show critical, warning, or info and above
- `--quiet` — Suppress the README badge output

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

When bumping the version (`npm version patch/minor/major`), update ALL of these hardcoded version strings:

**This repo (prodlint):**
1. `package.json` → `version` (handled by `npm version`)
2. `server.json` → both `version` fields (top-level and inside `packages[0]`)
3. `README.md` → terminal output example (`prodlint v0.x.x`)

**Website repo (prodlint-website):**
4. `app/components/animated-terminal.tsx` → terminal animation line (`prodlint v0.x.x`)
5. `app/layout.tsx` → JSON-LD `softwareVersion`
6. `app/mcp/page.tsx` → JSON-LD `softwareVersion`

**After updating all files, run these in order:**
1. `npm run build && npm test` (verify everything passes)
2. `npm publish` (publishes to npm, requires OTP)
3. `git tag -f v1 && git push origin v1 --force` (update v1 tag so GitHub Action users get the new version)
4. `./mcp-publisher.exe publish` (update MCP registry — requires `mcp-publisher.exe login github` if not already logged in)
5. `npm run build` (website repo, then push to deploy)

### npm Package

`files` field includes only `dist/**/*.js`, `dist/**/*.d.ts`, and `action.yml`. Source maps are built but excluded from the published tarball (~22 KB).
