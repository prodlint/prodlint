# prodlint

[![npm version](https://img.shields.io/npm/v/prodlint.svg)](https://www.npmjs.com/package/prodlint)
[![npm downloads](https://img.shields.io/npm/dm/prodlint.svg)](https://www.npmjs.com/package/prodlint)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

Production readiness for vibe-coded apps.

Static analysis for vibe-coded apps. Flags the security, reliability, performance, and AI quality issues that Cursor, v0, Bolt, and Copilot create — hallucinated imports, missing auth, hardcoded secrets, unvalidated server actions, and more. Zero config, no LLM, 52 rules, under 100ms.

```bash
npx prodlint
```

```
  prodlint v0.8.0
  Scanned 148 files · 3 critical · 5 warnings

  src/app/api/checkout/route.ts
    12:1  CRIT  No rate limiting — anyone could spam this endpoint and run up your API costs  rate-limiting
    28:5  WARN  Empty catch block silently swallows error  shallow-catch

  src/actions/submit.ts
    5:3   CRIT  Server action uses formData without validation  next-server-action-validation
      ↳ Validate with Zod: const data = schema.safeParse(Object.fromEntries(formData))

  src/lib/db.ts
    1:1   CRIT  Package "drizzle-orm" is imported but not in package.json  hallucinated-imports

  Scores
  security        72 ████████████████░░░░  (8 issues)
  reliability     85 █████████████████░░░  (4 issues)
  performance     95 ███████████████████░  (1 issue)
  ai-quality      90 ██████████████████░░  (3 issues)

  Overall: 82/100 (weighted)

  3 critical · 5 warnings · 3 info
```

## Why?

Vibe coding is the fastest way to build. Shipping fast means knowing your code is production-ready — not just that it compiles. Hardcoded secrets, hallucinated packages, missing auth, and XSS vectors pass type-checks and look correct — but they aren't ready for production.

prodlint checks what TypeScript and ESLint don't: **whether your vibe-coded app is ready for production**.

## Install

```bash
npx prodlint                              # Run directly (no install)
npx prodlint ./my-app                     # Scan specific path
npx prodlint --json                       # JSON output for CI
npx prodlint --ignore "*.test.ts"         # Ignore patterns
npx prodlint --min-severity warning       # Only warnings and criticals
npx prodlint --quiet                      # Suppress badge output
```

Or install it:

```bash
npm i -D prodlint     # Project dependency
npm i -g prodlint     # Global install
```

## 52 Rules across 4 Categories

### Security (27 rules)

| Rule | What it checks |
|------|----------------|
| `secrets` | API keys, tokens, passwords hardcoded in source |
| `auth-checks` | API routes with no authentication |
| `env-exposure` | `NEXT_PUBLIC_` on server-only secrets |
| `input-validation` | Request body used without validation |
| `cors-config` | `Access-Control-Allow-Origin: *` |
| `unsafe-html` | `dangerouslySetInnerHTML` with user data |
| `sql-injection` | String-interpolated SQL queries (ORM-aware) |
| `open-redirect` | User input passed to `redirect()` |
| `rate-limiting` | API routes with no rate limiter |
| `phantom-dependency` | Packages in node_modules but missing from package.json |
| `insecure-cookie` | Session cookies missing httpOnly/secure/sameSite |
| `leaked-env-in-logs` | `process.env.*` inside console.log calls |
| `insecure-random` | `Math.random()` used for tokens, secrets, or session IDs |
| `next-server-action-validation` | Server actions using formData without Zod/schema validation |
| `env-fallback-secret` | Security-sensitive env vars with hardcoded fallback values |
| `verbose-error-response` | Error stack traces or messages leaked in API responses |
| `missing-webhook-verification` | Webhook routes without signature verification |
| `server-action-auth` | Server actions with mutations but no auth check |
| `eval-injection` | `eval()`, `new Function()`, dynamic code execution |
| `next-public-sensitive` | `NEXT_PUBLIC_` prefix on secret env vars |
| `ssrf-risk` | User-controlled URLs passed to fetch in server code |
| `path-traversal` | File system operations with unsanitized user input |
| `unsafe-file-upload` | File upload handlers without type or size validation |
| `supabase-missing-rls` | `CREATE TABLE` in migrations without enabling RLS |
| `deprecated-oauth-flow` | OAuth Implicit Grant (response_type=token) |
| `jwt-no-expiry` | JWT tokens signed without an expiration |
| `client-side-auth-only` | Password comparisons or auth logic in client components |

### Reliability (11 rules)

| Rule | What it checks |
|------|----------------|
| `hallucinated-imports` | Imports of packages not in package.json |
| `error-handling` | Async operations without try/catch |
| `unhandled-promise` | Floating promises with no await or .catch |
| `shallow-catch` | Empty catch blocks that swallow errors |
| `missing-loading-state` | Client components that fetch without a loading state |
| `missing-error-boundary` | Route layouts without a matching error.tsx |
| `missing-transaction` | Multiple Prisma writes without `$transaction` |
| `redirect-in-try-catch` | `redirect()` inside try/catch — Next.js redirect throws, catch swallows it |
| `missing-revalidation` | Server actions with DB mutations but no `revalidatePath` |
| `missing-useeffect-cleanup` | useEffect with subscriptions/timers but no cleanup return |
| `hydration-mismatch` | `window`/`Date.now()`/`Math.random()` in server component render path |

### Performance (6 rules)

| Rule | What it checks |
|------|----------------|
| `no-sync-fs` | `readFileSync` in API routes |
| `no-n-plus-one` | Database calls inside loops |
| `no-unbounded-query` | `.findMany()` / `.select('*')` with no limit |
| `no-dynamic-import-loop` | `import()` inside loops |
| `server-component-fetch-self` | Server components fetching their own API routes |
| `missing-abort-controller` | Fetch calls without timeout or AbortController |

### AI Quality (8 rules)

| Rule | What it checks |
|------|----------------|
| `ai-smells` | `any` types, `console.log`, TODO comments piling up |
| `placeholder-content` | Lorem ipsum, example emails, "your-api-key-here" left in production code |
| `hallucinated-api` | `.flatten()`, `.contains()`, `.substr()` — methods AI invents |
| `stale-fallback` | `localhost:3000` hardcoded in production code |
| `comprehension-debt` | Functions over 80 lines, deep nesting, too many parameters |
| `codebase-consistency` | Mixed naming conventions across the project |
| `dead-exports` | Exported functions that nothing imports |
| `use-client-overuse` | `"use client"` on files that don't use any client-side APIs |

## Smart Detection

prodlint avoids common false positives:

- **AST parsing** — Babel-based analysis for 12 rules (imports, catch blocks, redirects, SSRF, path traversal, JWT, HTML injection, hydration, transactions, env leaks, loops, SQL) with regex fallback
- **Monorepo support** — npm/yarn/pnpm workspace dependencies resolved automatically
- **Framework awareness** — Prisma, Drizzle, Supabase, Knex, and Sequelize whitelists prevent false SQL injection flags
- **Middleware detection** — Clerk, NextAuth, Supabase middleware detected — auth findings downgraded
- **Block comment awareness** — patterns inside `/* */` are ignored
- **Path alias support** — `@/`, `~/`, and tsconfig paths aren't flagged as hallucinated imports
- **Route exemptions** — auth, webhook, health, and cron routes are exempt from auth/rate-limit checks
- **Test/script file awareness** — lower severity for non-production files
- **Fix suggestions** — findings include actionable `fix` hints with remediation code

## Scoring

Each category starts at 100. Deductions per finding:

| Severity | Deduction | Per-rule cap |
|----------|-----------|--------------|
| critical | -8 | max 1 |
| warning | -2 | max 2 |
| info | -0.5 | max 3 |

**Diminishing returns**: after 30 points deducted in a category, further deductions are halved; after 50, quartered.

**Weighted overall**: security 40%, reliability 30%, performance 15%, ai-quality 15%. Floor at 0. Exit code `1` if any critical findings exist.

## GitHub Action

Add to `.github/workflows/prodlint.yml`:

```yaml
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

Posts a score breakdown as a PR comment and fails the build if below threshold.

| Input | Default | Description |
|-------|---------|-------------|
| `path` | `.` | Path to scan |
| `threshold` | `0` | Minimum score to pass (0-100) |
| `ignore` | | Comma-separated glob patterns to ignore |
| `comment` | `true` | Post PR comment with results |

| Output | Description |
|--------|-------------|
| `score` | Overall score (0-100) |
| `critical` | Number of critical findings |

## MCP Server

Use prodlint inside Cursor, Claude Code, or any MCP-compatible editor:

**Claude Code:**
```bash
claude mcp add prodlint npx prodlint-mcp
```

**Cursor / Windsurf:**
```json
{
  "mcpServers": {
    "prodlint": {
      "command": "npx",
      "args": ["-y", "prodlint-mcp"]
    }
  }
}
```

Ask your AI: *"Run prodlint on this project"* and it calls the `scan` tool directly.

## Site Score

Check any deployed website for AI agent-readiness — 14 checks covering emerging standards like llms.txt, TDMRep, AgentCard, AI-Disclosure, HTTP Signatures (RFC 9421), and more.

```bash
npx prodlint --web example.com
npx prodlint --web example.com --json     # JSON output
```

```
  prodlint site score
  example.com · 14 checks

  Score: 42 C  ████████░░░░░░░░░░░░

  ✗ AI-Disclosure Header          0/10  No AI-Disclosure header found.
  ✗ Content-Usage Directives      0/10  No Content-Usage directives found.
  ✗ TDMRep                        0/10  No TDMRep found.
  ✗ A2A AgentCard                  0/5  No agent-card.json found.
  ✗ ai.txt                         0/5  No ai.txt found at site root.
  ! llms.txt                       2/5  llms.txt found but missing key sections.
  ✓ robots.txt                   10/10  robots.txt found with 15 rules.
  ✓ Sitemap                      10/10  Valid sitemap with 42 URLs.
  ✓ Structured Data              10/10  Found JSON-LD structured data.
  ✓ OpenGraph                    10/10  Complete OpenGraph tags found.
  ✓ Page Speed                    5/5   Loaded in 0.8s.
  ✓ AI Bot Directives             5/5   AI-specific bot rules found.
  ✓ WebMCP Tools                   0/5  No WebMCP tools detected.

  7 passed · 5 failed · 1 warnings

  Full results: https://prodlint.com/score?url=example.com
```

Or check your score interactively at [prodlint.com/score](https://prodlint.com/score).

## For AI Tools

- **LLM-friendly docs**: [prodlint.com/llms.txt](https://prodlint.com/llms.txt) — concise project summary for LLMs
- **Full reference**: [prodlint.com/llms-full.txt](https://prodlint.com/llms-full.txt) — all 52 rules with details
- **MCP setup guide**: [prodlint.com/mcp](https://prodlint.com/mcp) — detailed editor setup for Claude Code, Cursor, Windsurf

prodlint is designed specifically for AI-generated code patterns. Every rule checks for production issues that AI coding tools consistently create — not style nits.

## Suppression

Suppress a single line:
```ts
// prodlint-disable-next-line secrets
const key = "sk_test_example_for_docs"
```

Suppress an entire file (place at top):
```ts
// prodlint-disable secrets
```

## Programmatic API

```ts
import { scan } from 'prodlint'

const result = await scan({ path: './my-project' })
console.log(result.overallScore) // 0-100
console.log(result.findings)     // Finding[]
```

## Badge

```md
[![prodlint](https://img.shields.io/badge/prodlint-85%2F100-brightgreen)](https://prodlint.com)
```

## License

MIT
