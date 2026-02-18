# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run build        # tsup → dist/cli.js, dist/mcp.js, dist/index.js
npm run dev          # tsup --watch
npm run test         # vitest run (272 tests)
npm run test:watch   # vitest
npm run lint         # self-scan via node dist/cli.js .
```

Run a single test file: `npx vitest run tests/rules/secrets.test.ts`

## Architecture

Prodlint is a static analysis CLI that scans AI-generated JS/TS projects for production readiness issues. Three entry points built by tsup:

- **`src/cli.ts`** → `dist/cli.js` (shebang) — CLI via `npx prodlint`
- **`src/mcp.ts`** → `dist/mcp.js` (shebang) — MCP server via `npx prodlint-mcp`
- **`src/index.ts`** → `dist/index.js` + `.d.ts` — public API (`import { scan } from 'prodlint'`)

### Scan Flow

```
cli.ts (parseArgs) → scanner.ts (scan)
  → file-walker.ts (fast-glob + default ignores)
  → readFileContext() per file (content, lines, commentMap)
  → buildProjectContext() once (package.json deps, tsconfig paths, middleware detection)
  → for each file × each rule: rule.check(file, project) → Finding[]
  → isLineSuppressed() filters suppressed findings
  → scorer.ts (per-category 100 minus deductions, overall = average)
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

Rules are registered in `src/rules/index.ts`. Currently 27 rules across all 4 categories (security: 10, reliability: 6, performance: 4, ai-quality: 7).

### Two-Phase Scanning

- **Phase 1**: Per-file rules — `rule.check(file, project)` called for each file
- **Phase 2**: Project-level rules — `rule.checkProject(allFiles, project)` called once with all FileContexts

Project-level rules: `codebase-consistency`, `dead-exports`, `phantom-dependency`

### Shared Utilities (`src/utils/patterns.ts`)

- `isApiRoute(path)` — Next.js API route detection
- `isClientComponent(content)` / `isServerComponent(content)` — "use client" detection
- `buildCommentMap(lines)` / `isCommentLine()` — comment handling
- `isLineSuppressed()` — prodlint-disable support
- `isTestFile(path)` — test/spec/\_\_tests\_\_ detection
- `isScriptFile(path)` — scripts/ directory detection
- `isConfigFile(path)` — *.config.*, .env*, next.config detection
- `findLoopBodies(lines, commentMap)` — loop body extraction via brace counting

### Key Patterns

- **Comment skipping**: All rules use `file.commentMap` (precomputed block comment map) + `isCommentLine()` to skip comments
- **Suppression**: `// prodlint-disable <ruleId>` (file-level) and `// prodlint-disable-next-line <ruleId>` (line-level), checked in `src/utils/patterns.ts`
- **Context-aware severity**: Some rules downgrade severity based on project context (e.g., auth-checks → info if middleware detected)
- **Threshold aggregation**: Rules like ai-smells count occurrences across a file, report once at line 1 if threshold exceeded
- **Deduplication**: hallucinated-imports uses a `seen` Set to avoid reporting the same missing package twice per file
- **Line/column numbering**: 1-indexed throughout

### Scoring

Each category starts at 100. Deductions: critical -10, warning -3, info -1 (floor 0). Overall = average of all category scores.

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

### npm Package

`files` field includes only `dist/**/*.js`, `dist/**/*.d.ts`, and `action.yml`. Source maps are built but excluded from the published tarball (~22 KB).
