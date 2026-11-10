## What

<!-- Brief description of the change -->

## Why

<!-- Motivation or issue reference -->

## Checklist

- [ ] `npm run build` passes
- [ ] `npm test` passes
- [ ] Self-scan passes: `node dist/cli.js . --ignore "tests/**"` (the tests hold flagged code on purpose, so plain `npm run lint` reports them)
- [ ] README updated (if adding a new rule or feature)
- [ ] `CHANGELOG.md` has a line under `[Unreleased]` (if a user would notice the change)
