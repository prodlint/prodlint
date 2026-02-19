# prodlint

[![npm version](https://img.shields.io/npm/v/prodlint.svg)](https://www.npmjs.com/package/prodlint)
[![npm downloads](https://img.shields.io/npm/dm/prodlint.svg)](https://www.npmjs.com/package/prodlint)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

Catch the bugs AI leaves behind.

prodlint scans AI-generated JavaScript and TypeScript projects for production readiness issues — hallucinated imports, missing auth, exposed secrets, N+1 queries, and more. No LLM required, just fast static analysis against known failure modes.

```bash
npx prodlint
```

```
  prodlint v0.5.0
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

AI code generators (Cursor, Copilot, v0, Bolt, Claude) write code that works in demos but breaks in production. Hardcoded secrets, hallucinated packages, missing auth, XSS vectors — these pass type-checks and look correct but aren't.

prodlint catches what TypeScript and ESLint miss: **production readiness gaps**.

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

## 32 Rules across 4 Categories

### Security (14 rules)

| Rule | What it catches |
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

### Reliability (7 rules)

| Rule | What it catches |
|------|----------------|
| `hallucinated-imports` | Imports of packages not in package.json |
| `error-handling` | Async operations without try/catch |
| `unhandled-promise` | Floating promises with no await or .catch |
| `shallow-catch` | Empty catch blocks that swallow errors |
| `missing-loading-state` | Client components that fetch without a loading state |
| `missing-error-boundary` | Route layouts without a matching error.tsx |
| `missing-transaction` | Multiple Prisma writes without `$transaction` |

### Performance (4 rules)

| Rule | What it catches |
|------|----------------|
| `no-sync-fs` | `readFileSync` in API routes |
| `no-n-plus-one` | Database calls inside loops |
| `no-unbounded-query` | `.findMany()` / `.select('*')` with no limit |
| `no-dynamic-import-loop` | `import()` inside loops |

### AI Quality (7 rules)

| Rule | What it catches |
|------|----------------|
| `ai-smells` | `any` types, `console.log`, TODO comments piling up |
| `placeholder-content` | Lorem ipsum, example emails, "your-api-key-here" left in production code |
| `hallucinated-api` | `.flatten()`, `.contains()`, `.substr()` — methods AI invents |
| `stale-fallback` | `localhost:3000` hardcoded in production code |
| `comprehension-debt` | Functions over 80 lines, deep nesting, too many parameters |
| `codebase-consistency` | Mixed naming conventions across the project |
| `dead-exports` | Exported functions that nothing imports |

## Smart Detection

prodlint avoids common false positives:

- **AST parsing** — Babel-based analysis for loops, imports, and SQL templates with regex fallback
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
