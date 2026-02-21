# AGENTS.md

This file tells AI coding agents how to use prodlint — production readiness for vibe-coded apps.

## What is prodlint?

prodlint is a zero-config static analysis tool for JavaScript and TypeScript projects. It checks the security, reliability, performance, and AI quality issues that AI coding tools consistently create — hardcoded secrets, missing auth, hallucinated imports, unvalidated server actions, and 48 more patterns. 52 rules, 4 categories, under 100ms, MIT licensed.

## Running prodlint

```bash
npx prodlint                              # Scan current directory
npx prodlint ./my-app                     # Scan specific path
npx prodlint --json                       # JSON output (for programmatic use)
npx prodlint --ignore "*.test.ts"         # Ignore patterns
npx prodlint --min-severity warning       # Only warnings and criticals
npx prodlint --quiet                      # Suppress badge output
```

Exit codes: 0 = no critical findings, 1 = critical findings exist, 2 = runtime error.

## MCP Server

prodlint has a built-in MCP server. To add it:

```bash
claude mcp add prodlint npx prodlint-mcp
```

The server exposes a `scan` tool that takes a `path` (absolute directory path) and optional `ignore` (glob patterns). It returns a score breakdown and findings list. Runs locally via stdio — no data leaves the machine.

## Interpreting Results

prodlint scores each category from 0 to 100:

- **Security** (27 rules, 40% of overall score) — secrets, auth, injection, CORS, cookies, SSRF, path traversal, file uploads, RLS, OAuth, JWT
- **Reliability** (11 rules, 30%) — hallucinated imports, error handling, promises, loading states, error boundaries, transactions, redirects, revalidation, useEffect cleanup, hydration
- **Performance** (6 rules, 15%) — sync fs, N+1 queries, unbounded queries, dynamic import loops, self-fetch, missing abort
- **AI Quality** (8 rules, 15%) — code smells, placeholders, hallucinated APIs, stale fallbacks, comprehension debt, consistency, dead exports, use client overuse

Severity levels: `critical` (blocks deployment), `warning` (should fix), `info` (consider fixing).

## Fixing Findings

Every finding includes a `fix` hint. Common patterns:

| Finding | Fix |
|---------|-----|
| `secrets` — hardcoded API key | Move to `.env`, access via `process.env.KEY` |
| `auth-checks` — no auth on API route | Add middleware or session check at route entry |
| `hallucinated-imports` — package not in package.json | Run `npm install <package>` or remove the import |
| `input-validation` — unvalidated request body | Add Zod schema: `const data = schema.parse(await req.json())` |
| `sql-injection` — string-interpolated SQL | Use parameterized queries: `db.query('SELECT * FROM users WHERE id = $1', [id])` |
| `shallow-catch` — empty catch block | Log the error: `catch (err) { console.error(err); throw err; }` |
| `missing-error-boundary` — no error.tsx | Create `error.tsx` next to `page.tsx` in the route segment |
| `no-n-plus-one` — DB call in loop | Use `WHERE id IN (...)` or `findMany({ where: { id: { in: ids } } })` |

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
- **Auth middleware**: Clerk, NextAuth, Supabase (downgrades auth findings when middleware exists)
- **Monorepos**: npm, yarn, pnpm workspaces (resolves cross-package dependencies)
- **Path aliases**: `@/`, `~/`, tsconfig paths (not flagged as hallucinated imports)
- **Route exemptions**: auth, webhook, health, cron routes exempt from auth/rate-limit checks

## CI Integration

```yaml
# .github/workflows/prodlint.yml
name: Prodlint
on: [pull_request]
jobs:
  scan:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: prodlint/prodlint@v1
        with:
          threshold: 50
```

## Programmatic API

```typescript
import { scan } from 'prodlint'

const result = await scan({ path: './my-project' })
// result.overallScore: number (0-100)
// result.findings: Finding[] (file, line, ruleId, severity, message, fix)
// result.categoryScores: { category, score, findingCount }[]
```

## Project Structure

```
src/
  cli.ts           → CLI entry point (npx prodlint)
  mcp.ts           → MCP server entry point (npx prodlint-mcp)
  index.ts         → Public API (import { scan } from 'prodlint')
  scanner.ts       → Core scan engine
  scorer.ts        → Scoring with per-rule caps and diminishing returns
  reporter.ts      → Terminal and JSON output
  rules/           → All 52 rule implementations
    index.ts        → Rule registry
    <rule-id>.ts    → Individual rule files
  utils/
    ast.ts          → Babel AST parsing and walking
    patterns.ts     → Regex helpers, comment handling, suppression
    frameworks.ts   → ORM/middleware detection and whitelists
tests/
  rules/            → One test file per rule (562+ tests)
```

## Links

- Homepage: https://prodlint.com
- Rules reference: https://prodlint.com/rules
- MCP setup: https://prodlint.com/mcp
- LLM docs: https://prodlint.com/llms.txt
- Full reference: https://prodlint.com/llms-full.txt
- GitHub: https://github.com/prodlint/prodlint
- npm: https://www.npmjs.com/package/prodlint
