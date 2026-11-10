# AGENTS.md

This file tells AI coding agents how to use prodlint — production readiness for vibe-coded apps — and, at the end, how to work on this repository.

## What is prodlint?

prodlint is a zero-config static analysis tool for JavaScript and TypeScript projects. It checks for the security, reliability, performance, and AI quality issues common in AI-generated code — hardcoded secrets, missing auth, hallucinated imports, unvalidated server actions, and 48 more patterns. 52 rules, 4 categories, MIT licensed. No LLM is involved, so the same code always gets the same result.

## Running prodlint

```bash
npx prodlint                              # Scan current directory
npx prodlint ./my-app                     # Scan specific path
npx prodlint --json                       # JSON output (for programmatic use)
npx prodlint --sarif                      # SARIF 2.1.0 output (for GitHub Code Scanning)
npx prodlint --summary                    # Quick pass/fail + top 3 blockers
npx prodlint --profile startup            # Only critical findings
npx prodlint --profile balanced           # Warnings and criticals
npx prodlint --profile strict             # All findings including info (the default)
npx prodlint --baseline .prodlint-baseline.json   # Only new findings since baseline
npx prodlint --baseline-save .prodlint-baseline.json  # Save current findings as baseline
npx prodlint --ignore "*.test.ts"         # Ignore patterns
npx prodlint --min-severity warning       # Only warnings and criticals
npx prodlint --quiet                      # Leave out the README badge suggestion
npx prodlint --web example.com            # Score a deployed site for AI-agent readiness
```

Exit codes: 0 = no critical findings, 1 = critical findings exist, 2 = the scan couldn't run. The exit code follows the findings that are shown, so `--min-severity`, `--profile` and `--baseline` change it; the scores don't change.

### Reading `--json`

One object: `version`, `scannedPath`, `filesScanned`, `scanDurationMs`, `overallScore` (0-100), `categoryScores` (`category`, `score`, `findingCount` for each of the four), `summary` (`critical`, `warning`, `info` counts) and `findings`. Each finding has `ruleId`, `file` (relative, forward slashes), `line` and `column` (both 1-based), `severity`, `category`, `message` and usually `fix`.

## MCP Server

prodlint has a built-in MCP server. To add it:

```bash
claude mcp add prodlint -- npx -y prodlint-mcp
```

The server exposes two read-only tools over stdio:

- `scan` takes a `path` (absolute directory path, inside the directory the server was started in) and optional `ignore` (glob patterns), `minSeverity` (`critical`, `warning` or `info`), `categories` and `maxFindings` (default 30). It returns a score breakdown and findings sorted most severe first; every critical finding is included even past `maxFindings`. It runs locally — no data leaves the machine.
- `scan-web` takes a `url` and scores the deployed site's AI-agent readiness, so it fetches that site.

Both return Markdown plus structured output (`structuredContent`) that matches each tool's `outputSchema`.

## Interpreting Results

prodlint scores each category from 0 to 100:

- **Security** (27 rules, 40% of overall score) — secrets, auth, injection, CORS, cookies, SSRF, path traversal, file uploads, RLS, OAuth, JWT
- **Reliability** (11 rules, 30%) — hallucinated imports, error handling, promises, loading states, error boundaries, transactions, redirects, revalidation, useEffect cleanup, hydration
- **Performance** (6 rules, 15%) — sync fs, N+1 queries, unbounded queries, dynamic import loops, self-fetch, missing abort
- **AI Quality** (8 rules, 15%) — code smells, placeholders, hallucinated APIs, stale fallbacks, comprehension debt, consistency, dead exports, use client overuse

Severity levels: `critical` (blocks deployment), `warning` (should fix), `info` (consider fixing).

A score can stay high with critical findings in it, because each rule's deductions are capped. Go by the findings and the exit code, not the score alone.

## Fixing Findings

Every finding includes a `fix` hint. Common patterns:

| Finding | Fix |
|---------|-----|
| `secrets` — hardcoded API key | Move to `.env`, access via `process.env.KEY` |
| `auth-checks` — no auth on API route | Add middleware or session check at route entry |
| `hallucinated-imports` — package not in package.json | Run `npm install <package>` or remove the import |
| `input-validation` — unvalidated request body | Add Zod schema: `const data = schema.parse(await req.json())` |
| `sql-injection` — string-interpolated SQL | Use parameterized queries: `db.query('SELECT * FROM users WHERE id = $1', [id])` |
| `shallow-catch` — empty catch block | Log the error and rethrow: `catch (err) { console.error(err); throw err; }` |
| `missing-error-boundary` — no error.tsx | Create `error.tsx` next to the `layout.tsx` it was reported on |
| `no-n-plus-one` — DB call in loop | Use `WHERE id IN (...)` or `findMany({ where: { id: { in: ids } } })` |

Each rule has a page with a flagged example and its fix: `https://prodlint.com/rules/<rule-id>`.

## Suppressing False Positives

```typescript
// Suppress one line:
// prodlint-disable-next-line secrets
const key = "sk_test_example_for_docs"

// Suppress entire file (place at top):
// prodlint-disable secrets
```

## Framework Awareness

prodlint detects and adjusts for:
- **ORMs**: Prisma, Drizzle, Supabase, Knex, Sequelize (prevents false SQL injection flags)
- **Auth middleware**: Clerk, NextAuth, Supabase in `middleware.ts` or Next.js 16's `proxy.ts` (downgrades auth findings when middleware exists)
- **Monorepos**: npm, yarn, pnpm workspaces (resolves cross-package dependencies)
- **Path aliases**: `@/`, `~/`, tsconfig paths (not flagged as hallucinated imports)
- **Route exemptions**: auth, webhook, health, cron routes exempt from auth/rate-limit checks

## CI Integration

```yaml
# .github/workflows/prodlint.yml
name: Prodlint
on: [pull_request]
permissions:
  contents: read
  pull-requests: write   # for the PR comment
jobs:
  scan:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - uses: prodlint/prodlint@v1
        with:
          threshold: 50
```

### SARIF + GitHub Code Scanning

Upload findings to GitHub's Security tab (the job needs `security-events: write`):

```yaml
- run: npx prodlint --sarif > prodlint.sarif || true   # exit 1 on criticals would skip the upload
- uses: github/codeql-action/upload-sarif@v4
  with:
    sarif_file: prodlint.sarif
    category: prodlint
```

### Baseline (for existing projects)

Adopt prodlint gradually — only fail on new findings:

```bash
npx prodlint --baseline-save .prodlint-baseline.json   # Save snapshot
npx prodlint --baseline .prodlint-baseline.json         # CI: only new findings
```

## Programmatic API

```typescript
import { scan } from 'prodlint'

const result = await scan({ path: './my-project' })
// result.overallScore: number (0-100)
// result.findings: Finding[] (file, line, ruleId, severity, message, fix)
// result.categoryScores: { category, score, findingCount }[]
```

## Working on this repository

[CLAUDE.md](CLAUDE.md) is the detailed guide: architecture, how each rule family reads code, and the release process. The short version:

```bash
npm ci
npm run build        # tsup -> dist/ (the CLI and MCP tests run the built files, so build first)
npm test             # vitest; needs Node 22.12 or later
npx vitest run tests/rules/secrets.test.ts          # one file
node dist/cli.js . --ignore "tests/**"              # the self-scan CI runs
npm run verify:release                               # version strings and release metadata agree
```

- A rule is one file in `src/rules/`, registered in `src/rules/index.ts`, with tests in `tests/rules/`. Add it to the README's rule table too; `tests/readme.test.ts` fails if a rule is missing from it.
- The README's sample output is real: it's what prodlint prints for `tests/fixtures/readme-demo`, and the same test compares them. If a change alters that output, paste the new output into the README.
- Don't edit version numbers by hand. `npm version` runs `scripts/sync-versions.cjs`, which owns them.
- Anything a user would notice goes in `CHANGELOG.md` under `[Unreleased]`.
- Rules are deterministic: no network requests, no LLM calls.

## Project Structure

```
src/
  cli.ts           → CLI entry point (npx prodlint)
  mcp.ts           → MCP server entry point (npx prodlint-mcp)
  index.ts         → Public API (import { scan } from 'prodlint')
  scanner.ts       → Core scan engine
  scorer.ts        → Scoring with per-rule caps and diminishing returns
  reporter.ts      → Terminal, JSON and SARIF output
  rules/           → All 52 rule implementations
    index.ts        → Rule registry
    <rule-id>.ts    → Individual rule files
  utils/
    ast.ts          → Babel AST parsing and walking
    patterns.ts     → Regex helpers, comment handling, suppression
    frameworks.ts   → ORM/middleware detection and whitelists
  web-scanner/     → Site Score (--web and the scan-web tool)
tests/
  rules/            → One test file per rule
  fixtures/         → The demo app behind the README's sample output
action.yml         → The GitHub Action
scripts/           → Release and Action helpers
```

## Links

- Homepage: https://prodlint.com
- Rules reference: https://prodlint.com/rules
- MCP setup: https://prodlint.com/mcp
- LLM docs: https://prodlint.com/llms.txt
- Full reference: https://prodlint.com/llms-full.txt
- GitHub: https://github.com/prodlint/prodlint
- npm: https://www.npmjs.com/package/prodlint
