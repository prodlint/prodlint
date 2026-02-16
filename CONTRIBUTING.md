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
npm test          # Run all tests
npm run test:watch # Watch mode
```

## Adding a New Rule

1. Create a new file in `src/rules/` (e.g., `my-rule.ts`)
2. Export a `Rule` object matching the interface in `src/types.ts`
3. Register it in `src/rules/index.ts`
4. Add tests in `tests/rules/my-rule.test.ts`
5. Update `README.md` rule table

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
3. Run `npm test` and `npm run build`
4. Submit a PR with a clear description

## Code Style

- TypeScript strict mode
- No runtime dependencies beyond `fast-glob` and `picocolors`
- Deterministic rules only (no LLM calls, no network requests)
