TITLE:
Show HN: Prodlint – The missing linter for vibe-coded apps

URL: https://github.com/prodlint/prodlint
(HN devs prefer seeing the repo directly. Your landing page is linked in the README.)

---

FIRST COMMENT (post this immediately after submitting):

I've been vibe coding for the past year — Cursor, v0, Bolt, the works — and kept noticing the same patterns in what they generate: API routes with zero auth, catch blocks that do nothing, database queries inside loops, imports of packages that don't exist on npm, no rate limiting anywhere.

None of it breaks locally. Tests pass, types check, everything looks fine. But these are the kinds of things that blow up in production, and AI assistants produce them consistently.

So I built prodlint. It's a linter tuned specifically for patterns AI gets wrong. `npx prodlint` in any JS/TS project gives you a 0-100 score across security, reliability, performance, and "AI quality" (stuff like TODO placeholders, hallucinated imports, inconsistent naming from copy-pasting different AI outputs).

52 rules right now. Some examples:

- SQL injection via string concatenation (ORM-aware — won't false-flag Prisma/Drizzle)
- Server actions using formData without Zod validation
- Packages that don't actually exist on npm (AI hallucinates names constantly)
- Session cookies missing httpOnly/secure/sameSite
- Missing auth on API routes (middleware-aware)
- Math.random() used for tokens or secrets

Also runs as an MCP server (`npx prodlint-mcp`) so your AI editor can use it while writing code. And there's a GitHub Action that posts scores on PRs.

I ran it on my own production app and it flagged 8 critical issues across 175 files that I'd missed during review.

175 files in ~600ms, zero config, 22kb on npm. MIT licensed.

What keeps breaking in your vibe-coded apps? Always looking for new rules to add.

https://prodlint.com
