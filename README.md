# prodlint

[![npm version](https://img.shields.io/npm/v/prodlint.svg)](https://www.npmjs.com/package/prodlint)
[![npm downloads](https://img.shields.io/npm/dm/prodlint.svg)](https://www.npmjs.com/package/prodlint)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

Production readiness for vibe-coded apps.

Static analysis for vibe-coded apps. Flags the security, reliability, performance, and AI quality issues common in code from tools like Claude Code, Cursor, v0, Bolt, and Copilot: hallucinated imports, missing auth, hardcoded secrets, unvalidated server actions, and more. Zero config, no LLM, 52 rules.

```bash
npx prodlint
```

```
  prodlint v0.10.7
  Scanned 6 files · 3 critical · 2 warnings · 1 info

app/api/users/route.ts
  3:1  CRIT  API route has no authentication check  auth-checks
        ↳ Add authentication check: const session = await auth(); if (!session) return new Response('Unauthorized', { status: 401 })
  4:1  WARN  Request body accessed without validation (consider using Zod, Yup, or similar)  input-validation
        ↳ Validate input with Zod or a similar schema library before using it
  3:1  INFO  No rate limiting — anyone could spam this endpoint and run up your API costs  rate-limiting
        ↳ Add rate limiting: import { Ratelimit } from '@upstash/ratelimit' or use express-rate-limit
  3:1  WARN  API route handler has no try/catch block  error-handling
        ↳ Wrap the handler body in try/catch and return appropriate error responses

lib/format.ts
  1:1  CRIT  Package "currency-format-utils" is imported but not in package.json  hallucinated-imports
        ↳ Verify the package exists on npm. The AI may have invented this package name.

lib/stripe.ts
  3:35  CRIT  Hardcoded Stripe secret key detected  secrets
        ↳ Move the secret to an environment variable and access via process.env.SECRET_NAME

  Scores
  security        82 ████████████████░░░░  (4 issues)
  reliability     90 ██████████████████░░  (2 issues)
  performance    100 ████████████████████  (0 issues)
  ai-quality     100 ████████████████████  (0 issues)

  Overall: 90/100

  3 critical · 2 warnings · 1 info

  Add to your README:
  [![prodlint](https://img.shields.io/badge/prodlint-90%2F100-brightgreen)](https://prodlint.com)
```

That's what prodlint prints for the six-file app in [`tests/fixtures/readme-demo`](tests/fixtures/readme-demo). A test fails if this block and the scanner ever disagree.

## Why?

Vibe coding is the fastest way to build. Shipping fast means knowing your code is production-ready — not just that it compiles. Hardcoded secrets, hallucinated packages, missing auth, and XSS vectors pass type-checks and look correct — but they aren't ready for production.

prodlint checks what TypeScript and ESLint don't: **whether your vibe-coded app is ready for production**. It runs next to them, not instead of them.

## Install

```bash
npx prodlint                              # Run directly (no install)
npx prodlint ./my-app                     # Scan specific path
npx prodlint --json                       # JSON output for CI
npx prodlint --sarif                      # SARIF 2.1.0 for GitHub Code Scanning
npx prodlint --summary                    # Quick pass/fail + top 3 blockers
npx prodlint --profile startup            # Only critical findings
npx prodlint --profile balanced           # Warnings and criticals
npx prodlint --profile strict             # All findings including info (the default)
npx prodlint --min-severity warning       # Only warnings and criticals
npx prodlint --baseline-save .prodlint-baseline.json   # Save today's findings
npx prodlint --baseline .prodlint-baseline.json        # Only findings that aren't in it
npx prodlint --ignore "*.test.ts"         # Ignore patterns (repeatable)
npx prodlint --quiet                      # Leave out the README badge suggestion
npx prodlint --web example.com            # Score a deployed site instead (see Site Score)
```

Or install it:

```bash
npm i -D prodlint     # Project dependency
npm i -g prodlint     # Global install
```

Node.js 18 or later.

### Exit codes

| Code | Meaning |
|------|---------|
| `0` | No critical findings among the ones shown |
| `1` | At least one critical finding |
| `2` | The scan couldn't run: a bad flag, file or URL, or an unexpected error |

`--min-severity`, `--profile` and `--baseline` decide which findings are shown, and the exit code follows what's shown. Scores are always worked out from every finding.

### JSON output

`--json` prints one object:

```jsonc
{
  "version": "0.10.7",
  "scannedPath": ".",                      // the path argument
  "filesScanned": 6,
  "scanDurationMs": 39,
  "findings": [
    {
      "ruleId": "secrets",
      "file": "lib/stripe.ts",             // relative to the scanned path, forward slashes
      "line": 3,                           // 1-based
      "column": 35,                        // 1-based
      "message": "Hardcoded Stripe secret key detected",
      "severity": "critical",              // critical | warning | info
      "category": "security",              // security | reliability | performance | ai-quality
      "fix": "Move the secret to an environment variable and access via process.env.SECRET_NAME"
    }
    // one object per finding
  ],
  "overallScore": 90,                      // 0-100, weighted across the categories
  "categoryScores": [
    { "category": "security", "score": 82, "findingCount": 4 }
    // then reliability, performance, ai-quality
  ],
  "summary": { "critical": 3, "warning": 2, "info": 1 }
}
```

`fix` is there on every finding today, but treat it as optional.

## 52 Rules across 4 Categories

Each rule has a page with an example and a fix at `https://prodlint.com/rules/<rule-id>`.

### Security (27 rules)

| Rule | What it checks |
|------|----------------|
| `secrets` | Hardcoded API keys, tokens, private keys and database URLs with credentials |
| `auth-checks` | API routes with no authentication check (middleware-aware) |
| `env-exposure` | Server env vars read in client components; `.env` not in `.gitignore` |
| `input-validation` | Request body used without validation in an API route |
| `cors-config` | `Access-Control-Allow-Origin: *`, `cors()` with no config, `origin: true`; critical when the wildcard comes with credentials |
| `unsafe-html` | `dangerouslySetInnerHTML`, direct `innerHTML` assignment |
| `sql-injection` | SQL built with template literals or string concatenation (ORM-aware) |
| `open-redirect` | User input passed directly to `redirect()` |
| `rate-limiting` | API routes with no rate limiter |
| `phantom-dependency` | Dependencies with commonly hallucinated or suspicious package names (slopsquatting) |
| `insecure-cookie` | Session cookies set without `httpOnly`, `secure` or `sameSite` |
| `leaked-env-in-logs` | `process.env.*` inside `console.log()` calls |
| `insecure-random` | `Math.random()` used for tokens, secrets, or session IDs |
| `next-server-action-validation` | Server actions using `formData` without Zod/schema validation |
| `env-fallback-secret` | Secret env vars with hardcoded fallback values |
| `verbose-error-response` | Error stack traces and messages sent back in API responses |
| `missing-webhook-verification` | Webhook routes without signature verification |
| `server-action-auth` | Server actions that write data, send something out or call an AI model, with no auth check |
| `eval-injection` | `eval()`, `new Function()`, and strings passed to `setTimeout` or `setInterval` |
| `next-public-sensitive` | `NEXT_PUBLIC_` prefix on secret env vars |
| `ssrf-risk` | User-controlled URLs passed to fetch in server code |
| `path-traversal` | File system operations with unsanitized user input |
| `unsafe-file-upload` | File uploads without type or size validation |
| `supabase-missing-rls` | `CREATE TABLE` in migrations without enabling RLS |
| `deprecated-oauth-flow` | OAuth Implicit Grant (`response_type=token`) |
| `jwt-no-expiry` | JWT tokens signed without an expiration |
| `client-side-auth-only` | Password comparisons, or auth tokens kept in `localStorage`, in client components |

### Reliability (11 rules)

| Rule | What it checks |
|------|----------------|
| `hallucinated-imports` | Imports of packages that aren't in `package.json` |
| `error-handling` | API route handlers with no try/catch |
| `unhandled-promise` | `fetch` and database calls with no `await`, `return` or assignment |
| `shallow-catch` | Catch blocks that are empty, ignore the error, or log without it |
| `missing-loading-state` | Client components that fetch without a loading state |
| `missing-error-boundary` | Route layouts with no `error.tsx` beside them |
| `missing-transaction` | Multiple Prisma writes without `$transaction` |
| `redirect-in-try-catch` | `redirect()` inside try/catch — Next.js redirect throws, catch swallows it |
| `missing-revalidation` | Server actions that change data with no `revalidatePath` or `revalidateTag` |
| `missing-useeffect-cleanup` | `useEffect` with timers, listeners or subscriptions and no cleanup |
| `hydration-mismatch` | `window`/`Date.now()`/`Math.random()` in server component render path |

### Performance (6 rules)

| Rule | What it checks |
|------|----------------|
| `no-sync-fs` | `readFileSync` and other synchronous `fs` calls in server code |
| `no-n-plus-one` | Database or fetch calls inside loops |
| `no-unbounded-query` | `.findMany()` / `.select('*')` with no limit |
| `no-dynamic-import-loop` | `import()` inside loops |
| `server-component-fetch-self` | Server components fetching their own API routes |
| `missing-abort-controller` | `fetch` or axios calls with no timeout, in API routes, server actions and background jobs |

### AI Quality (8 rules)

| Rule | What it checks |
|------|----------------|
| `ai-smells` | TODO and FIXME comments, piles of `console.log` and `any`, commented-out code, "not implemented" stubs |
| `placeholder-content` | Lorem ipsum, example emails, "John Doe" and "your-api-key-here" left in shipped code |
| `hallucinated-api` | `.flatten()`, `.contains()`, `.substr()` and other methods that don't exist or are deprecated |
| `stale-fallback` | Hardcoded localhost URLs, including as the fallback for an env var |
| `comprehension-debt` | Functions over 80 lines, nested more than 5 levels deep, or with more than 5 parameters |
| `codebase-consistency` | Conflicting conventions across files: export naming, import style, HTTP client, async style, quotes |
| `dead-exports` | Exported functions, constants and types that nothing imports |
| `use-client-overuse` | `"use client"` on files that don't use any client-side APIs |

## Smart Detection

prodlint avoids common false positives:

- **AST parsing** — Babel-based analysis for 15 rules (imports, catch blocks, redirects, redirects in try/catch, SSRF, path traversal, JWT, HTML injection, hydration, transactions, env leaks, loops, SQL, route handlers, server actions) with regex fallback
- **Monorepo support** — npm/yarn/pnpm workspace dependencies resolved automatically
- **Framework awareness** — Prisma, Drizzle, Supabase, Knex, and Sequelize whitelists prevent false SQL injection flags
- **Middleware detection** — Clerk, NextAuth, Supabase middleware (`middleware.ts`, or `proxy.ts` on Next.js 16) detected, matcher included — auth findings it covers drop to info
- **Block comment awareness** — patterns inside `/* */` are ignored
- **Path alias support** — `@/`, `~/`, and tsconfig paths aren't flagged as hallucinated imports
- **Route exemptions** — auth, webhook, health, and cron routes are skipped where a check wouldn't make sense
- **Test and script awareness** — most rules skip test files, and a missing package in a test or script is a warning, not critical
- **Fix suggestions** — every finding comes with a `fix` hint

## Scoring

Each category starts at 100. Deductions per finding:

| Severity | Deduction | Per-rule cap |
|----------|-----------|--------------|
| critical | -8 | max 1 |
| warning | -2 | max 2 |
| info | -0.5 | max 3 |

**Diminishing returns**: after 30 points deducted in a category, further deductions are halved; after 50, quartered.

**Weighted overall**: security 40%, reliability 30%, performance 15%, ai-quality 15%. Floor at 0.

The caps mean one noisy rule can't sink a score, and also that a score can stay high with critical findings in it: the sample at the top is 90 with three. Read the findings, and treat the exit code as the gate.

## GitHub Action

Add to `.github/workflows/prodlint.yml`:

```yaml
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

Posts a score breakdown as a PR comment, and fails the build when the scan finds critical
issues or the score is below `threshold`. Each release of the action runs its matching
prodlint version, so pinning the action (`@v1`, a version tag, or a commit SHA) also pins
the scanner.

| Input | Default | Description |
|-------|---------|-------------|
| `path` | `.` | Path to scan |
| `threshold` | `0` | Minimum score to pass (0-100) |
| `fail-on-critical` | `true` | Fail when the scan finds critical issues; `false` reports them without failing |
| `ignore` | | Comma-separated glob patterns to ignore |
| `comment` | `true` | Post PR comment with results |

| Output | Description |
|--------|-------------|
| `score` | Overall score (0-100) |
| `critical` | Number of critical findings |

### SARIF + GitHub Code Scanning

Upload prodlint results to GitHub's Security tab. The job needs `security-events: write`, and `|| true` keeps a critical finding from stopping the job before the upload:

```yaml
- name: Run prodlint
  run: npx prodlint --sarif > prodlint.sarif || true

- name: Upload SARIF
  uses: github/codeql-action/upload-sarif@v4
  with:
    sarif_file: prodlint.sarif
    category: prodlint
```

### Baseline for Existing Projects

Adopt prodlint gradually without drowning in pre-existing findings:

```bash
# Save current state as baseline
npx prodlint --baseline-save .prodlint-baseline.json

# CI only fails on NEW findings
npx prodlint --baseline .prodlint-baseline.json
```

## MCP Server

Use prodlint inside Cursor, Claude Code, or any MCP-compatible editor:

**Claude Code:**
```bash
claude mcp add prodlint -- npx -y prodlint-mcp
```

**Cursor / Windsurf / Claude Desktop:**
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

**VS Code** (`.vscode/mcp.json`; the key is `servers`):
```json
{
  "servers": {
    "prodlint": {
      "command": "npx",
      "args": ["-y", "prodlint-mcp"]
    }
  }
}
```

`prodlint-mcp` is a thin launcher for the server built into `prodlint`. It's published with
every prodlint release, so it always runs the matching scanner.

Ask your AI: *"Run prodlint on this project"* and it calls the `scan` tool directly.

| Tool | Inputs | Returns |
|------|--------|---------|
| `scan` | `path` (project directory), optional `ignore`, `minSeverity` (`critical` / `warning` / `info`), `categories`, `maxFindings` (default 30) | Score, category scores, and findings most severe first. Every critical finding is listed, even past `maxFindings`. |
| `scan-web` | `url` | Site score, grade, and the 14 agent-readiness checks |

Both tools return a Markdown summary plus structured output (`structuredContent` matching
each tool's `outputSchema`), and both are marked read-only (`readOnlyHint`), which hosted
reviewers such as GitHub Copilot code review require before they call an MCP tool.

`scan` reads files and sends nothing anywhere. It only scans a `path` inside the directory the
server was started in, so start it from your project. `scan-web` fetches the site you name,
from your machine.

## Site Score

Check any deployed website for AI agent-readiness — 14 checks covering emerging standards like llms.txt, TDMRep, AgentCard, AI-Disclosure, HTTP Signatures (RFC 9421), and more.

```bash
npx prodlint --web example.com
npx prodlint --web example.com --json     # JSON output
```

```
  prodlint site score
  example.com · 14 checks

  Score: 8 F  ██░░░░░░░░░░░░░░░░░░

  ✗ robots.txt                            0/7  No robots.txt found.
  ✗ AI robots.txt Directives             0/15  No robots.txt found. AI bots have no guidance.
  ✗ Content-Usage (IETF aipref)           0/5  No Content-Usage directives found.
  ✗ llms.txt                              0/6  No llms.txt found.
  ✗ ai.txt                                0/3  No ai.txt found at site root.
  ✗ TDMRep (W3C)                          0/4  No TDMRep configuration found.
  ✗ AI-Disclosure Header                  0/2  No AI-Disclosure header found.
  ✗ A2A AgentCard                         0/5  No A2A AgentCard found.
  ✗ WebMCP Tools                          0/5  No WebMCP tools detected.
  ✗ HTTP Message Signatures (RFC 9421)    0/3  No HTTP signature support detected.
  ✗ Structured Data                      0/12  No structured data found.
  ✗ OpenGraph & Meta                     0/10  No OpenGraph tags or meta description.
  ✗ sitemap.xml                          0/10  No sitemap.xml found.
  ✓ Page Load Time                        8/8  0.1s.

  1 passed · 13 failed

  Full results: https://prodlint.com/score?url=example.com
```

That's a real run: example.com is one bare page, so the only check it passes is answering quickly. Six of the checks are for settled things (robots.txt, rules for AI crawlers, structured data, Open Graph tags, a sitemap, response time) and carry 62 of the 95 points. The other eight are for drafts and proposals that may still change. A partial result earns half a check's points, rounded down, and the total is scaled to 100.

Or check your score interactively at [prodlint.com/score](https://prodlint.com/score).

## For AI Tools

- **Summary for LLMs**: [prodlint.com/llms.txt](https://prodlint.com/llms.txt)
- **Full reference**: [prodlint.com/llms-full.txt](https://prodlint.com/llms-full.txt) — every rule in one file
- **MCP setup guide**: [prodlint.com/mcp](https://prodlint.com/mcp)
- **Working on this repo**: [AGENTS.md](AGENTS.md) for using prodlint, [CLAUDE.md](CLAUDE.md) for how the code is laid out

prodlint is built for the patterns AI coding tools tend to leave behind. Every rule checks for something that breaks in production, not a style nit.

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

const result = await scan({ path: './my-project', ignore: ['legacy/**'] })
console.log(result.overallScore) // 0-100
console.log(result.findings)     // the same objects as --json
```

The package is ESM. It also exports `rules`, `runWebScan`, and the reporters `reportPretty`, `reportJson`, `reportSummary` and `reportSarif`.

## Badge

```md
[![prodlint](https://img.shields.io/badge/prodlint-85%2F100-brightgreen)](https://prodlint.com)
```

## License

MIT
