# prodlint-mcp

Thin launcher for [prodlint](https://www.npmjs.com/package/prodlint)'s MCP server. It exists
so that `npx -y prodlint-mcp` works as a one-liner; all it does is import `prodlint/mcp`.

This package is versioned in lockstep with `prodlint` and published from the same release
workflow, so it always depends on the matching scanner release.

```bash
claude mcp add prodlint -- npx -y prodlint-mcp
```

The `prodlint` package also exposes the same binary directly, if you prefer to pin the
scanner itself:

```bash
claude mcp add prodlint -- npx -y -p prodlint prodlint-mcp
```

See the [main README](https://github.com/prodlint/prodlint#readme) for configuration and
the full rule list.
