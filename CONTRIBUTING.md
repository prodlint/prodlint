# Contributing to prodlint

Thanks for your interest in contributing! Here's how to get started.

## Development Setup

```bash
git clone https://github.com/prodlint/prodlint.git
cd prodlint
npm install
npm run build
```

## Running Tests

```bash
npm test          # Run all tests (Node 22.12 or later; build first)
npm run test:watch # Watch mode
npx vitest run tests/rules/secrets.test.ts   # One file
```

The CLI and MCP server tests run the built files in `dist/`, so run `npm run build` before `npm test`.

## Adding a New Rule

1. Create a new file in `src/rules/` (e.g., `my-rule.ts`)
2. Export a `Rule` object matching the interface in `src/types.ts`
3. Register it in `src/rules/index.ts`
4. Add tests in `tests/rules/my-rule.test.ts`
5. Add it to the rule table in `README.md` and bump the counts there (`tests/readme.test.ts` fails if a rule is missing)
6. Add a line to `CHANGELOG.md` under `[Unreleased]`

### Rule Template

```ts
import type { Rule, Finding, FileContext, ProjectContext } from '../types.js'
import { isCommentLine } from '../utils/patterns.js'

export const myRule: Rule = {
  id: 'my-rule',
  name: 'My Rule',
  description: 'What it detects',
  category: 'security', // or 'reliability', 'performance', 'ai-quality'
  severity: 'warning',  // or 'critical', 'info'
  fileExtensions: ['ts', 'tsx', 'js', 'jsx'],

  check(file: FileContext, project: ProjectContext): Finding[] {
    const findings: Finding[] = []

    for (let i = 0; i < file.lines.length; i++) {
      if (isCommentLine(file.lines, i, file.commentMap)) continue
      // Your detection logic here
    }

    return findings
  },
}
```

## Pull Request Process

1. Fork the repo and create a feature branch
2. Make your changes with tests
3. Run `npm run build`, `npm test` and the self-scan: `node dist/cli.js . --ignore "tests/**"`
4. Submit a PR with a clear description

## Code Style

- TypeScript strict mode
- Few runtime dependencies: `@babel/parser` and `@babel/types` (syntax trees), `fast-glob`, `picocolors`, and for the MCP server `@modelcontextprotocol/sdk` and `zod`. Adding one needs a reason
- Deterministic rules only (no LLM calls, no network requests)

## Contributor License Agreement

By submitting a pull request, you agree to the terms in [CLA.md](CLA.md). In short: you grant us a license to use and relicense your contributions as part of this project, and you retain your copyright. Submitting a PR is your signature.
