# prodlint

[![CI](https://github.com/prodlint/prodlint/actions/workflows/ci.yml/badge.svg)](https://github.com/prodlint/prodlint/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/prodlint.svg)](https://www.npmjs.com/package/prodlint)
[![npm downloads](https://img.shields.io/npm/dm/prodlint.svg)](https://www.npmjs.com/package/prodlint)
[![prodlint](https://img.shields.io/badge/prodlint-99%2F100-brightgreen)](https://prodlint.com)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

Scan AI-generated projects for production readiness issues.

prodlint is a deterministic, zero-config CLI that checks your codebase for common problems in AI-generated and vibe-coded projects. No LLM required — just pattern matching against known anti-patterns.

## Why?

AI code generators (Cursor, Copilot, v0, Bolt) ship code that works in demos but breaks in production. Hardcoded secrets, hallucinated packages, missing auth checks, XSS vectors — these issues slip through because they're syntactically valid and pass type-checks.

prodlint catches what TypeScript and ESLint miss: **production readiness gaps**.

## Quick Start

```bash
npx prodlint
```

## Example Output

```
  prodlint v0.2.2
  Scanned 142 files in 87ms

  src/app/api/users/route.ts
    8:1  CRIT  API route has no authentication check              auth-checks
    8:1  WARN  API route has no rate limiting                     rate-limiting

  src/components/chat.tsx
   24:5  CRIT  Hardcoded Stripe secret key detected               secrets

  src/lib/db.ts
   15:1  CRIT  SQL query built with template literal interpolation sql-injection

  Scores
  security        40 ████████░░░░░░░░░░░░
  reliability     70 ██████████████░░░░░░
  performance     95 ███████████████████░
  ai-quality      88 ██████████████████░░

  Overall: 73/100

  3 critical · 4 warnings · 2 info
```

## Usage

```bash
npx prodlint                      # Scan current directory
npx prodlint ./my-app             # Scan specific path
npx prodlint --json               # JSON output
npx prodlint --ignore "*.test.ts" # Ignore patterns
```

## What It Checks

prodlint runs **11 rules** across 3 categories:

### Security
| Rule | Severity | What it detects |
|------|----------|----------------|
| `secrets` | critical | Hardcoded API keys (Stripe, AWS, Supabase, OpenAI, GitHub, SendGrid) |
| `env-exposure` | critical | Server env vars in client components, `.env` not in `.gitignore` |
| `auth-checks` | critical | API routes without authentication (middleware-aware) |
| `unsafe-html` | critical | `dangerouslySetInnerHTML`, direct `innerHTML` assignment |
| `sql-injection` | critical | SQL queries built with template literals or string concatenation |
| `input-validation` | warning | API routes accessing request body without validation |
| `rate-limiting` | warning | API routes without rate limiting |
| `cors-config` | warning | `Access-Control-Allow-Origin: *`, `cors()` with no config |

### Reliability
| Rule | Severity | What it detects |
|------|----------|----------------|
| `hallucinated-imports` | critical | Imports of packages not in `package.json` and not Node built-ins |
| `error-handling` | warning | API routes without try/catch, empty catch blocks |

### AI Quality
| Rule | Severity | What it detects |
|------|----------|----------------|
| `ai-smells` | mixed | TODOs, placeholder functions, console.log spam, excessive `any`, commented-out code |

## Scoring

Each category starts at 100 points. Deductions:

- **Critical**: -10 points
- **Warning**: -3 points
- **Info**: -1 point

Overall score = average of all category scores. Exit code is `1` if any critical findings exist, `0` otherwise.

## Smart Detection

prodlint avoids common false positives:

- **Block comment awareness** — patterns inside `/* */` comments are ignored
- **Middleware auth detection** — if your project uses Clerk/NextAuth/Supabase middleware, auth findings are downgraded to info
- **TypeScript path aliases** — `@/`, `~/`, and custom tsconfig paths aren't flagged as hallucinated imports
- **Route exemptions** — auth, webhook, health, and cron routes are exempt from auth/rate-limit checks

## GitHub Action

Add prodlint to your CI pipeline. It posts a score summary as a PR comment and can fail builds below a threshold.

```yaml
- uses: prodlint/prodlint@v1
  with:
    threshold: 70    # Fail if score < 70 (optional)
    comment: true    # Post PR comment (default: true)
    ignore: '*.test.ts, __mocks__/**'  # Ignore patterns (optional)
```

**Inputs:**
| Input | Default | Description |
|-------|---------|-------------|
| `path` | `.` | Path to scan |
| `threshold` | `0` | Minimum score to pass (0-100) |
| `ignore` | `''` | Comma-separated glob patterns to ignore |
| `comment` | `true` | Post a PR comment with results |

**Outputs:**
| Output | Description |
|--------|-------------|
| `score` | Overall score (0-100) |
| `critical` | Number of critical findings |

## MCP Server

prodlint ships an MCP server for AI coding tools (Cursor, Claude Code, Windsurf, etc.).

```bash
npx prodlint-mcp
```

### Claude Code

```bash
claude mcp add prodlint npx prodlint-mcp
```

### Cursor / Windsurf

Add to your MCP config:

```json
{
  "mcpServers": {
    "prodlint": {
      "command": "npx",
      "args": ["prodlint-mcp"]
    }
  }
}
```

The MCP server exposes a single `scan` tool that accepts a project path and returns the full score breakdown with findings.

## Suppressing Findings

Suppress a single line:
```ts
// prodlint-disable-next-line secrets
const key = "sk_test_example_for_documentation"
```

Suppress multiple rules:
```ts
// prodlint-disable-next-line secrets, auth-checks
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

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup and how to add new rules.

## License

MIT
