# prodlint-mcp

The [MCP](https://modelcontextprotocol.io) server for [prodlint](https://www.npmjs.com/package/prodlint): production-readiness checks for AI-generated JavaScript and TypeScript, run from inside your AI editor. Your assistant scans the project, reads the findings as data, and fixes them.

This package is a thin launcher, so that `npx -y prodlint-mcp` works as a one-liner; all it does is import `prodlint/mcp`. It's versioned in lockstep with `prodlint` and published from the same release workflow, so it always runs the matching scanner.

## Setup

Node.js 18 or later. Every client needs the same two things: the command `npx` and the arguments `-y prodlint-mcp`.

**Claude Code**, from your project directory:

```bash
claude mcp add prodlint -- npx -y prodlint-mcp
```

**Cursor** (`.cursor/mcp.json`), **Windsurf** and **Claude Desktop**:

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

**VS Code** (`.vscode/mcp.json`; the key is `servers`, not `mcpServers`):

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

Then ask: *"Run prodlint on this project"*.

The `prodlint` package exposes the same binary, if you'd rather pin the scanner itself:

```bash
claude mcp add prodlint -- npx -y -p prodlint prodlint-mcp
```

## Tools

Both tools are read-only (`readOnlyHint`) and return a Markdown summary plus structured output (`structuredContent`) that matches the tool's `outputSchema`.

### `scan`

Runs prodlint's 52 rules on a project directory. Nothing leaves your machine.

| Input | Type | |
|-------|------|---|
| `path` | string, required | Absolute path of the directory to scan. It has to be inside the directory the server was started in |
| `ignore` | string[] | Glob patterns to skip |
| `minSeverity` | `critical` \| `warning` \| `info` | Only list findings at this level or above. Default `info`, which is all of them |
| `categories` | string[] | Any of `security`, `reliability`, `performance`, `ai-quality` |
| `maxFindings` | 1 to 500 | How many findings to list. Default 30. Critical findings are always listed in full |

Returns `version`, `path`, `score` (0-100), `filesScanned`, `durationMs`, `categoryScores`, `summary` (counts before filtering), `matched`, `omitted`, and `findings`, most severe first, each with `ruleId`, `severity`, `category`, `file`, `line`, `column`, `message` and usually `fix`.

### `scan-web`

Scores a deployed site out of 100 on 14 AI-agent readiness checks: robots.txt rules for AI crawlers, llms.txt, structured data and more. This one uses the network: it fetches the site you name, from your machine. Private and internal hosts are refused.

| Input | Type | |
|-------|------|---|
| `url` | string, required | The site to score, with or without `https://` |

Returns `url`, `domain`, `score`, `grade`, `summary` (`passed`, `failed`, `warnings`, `totalChecks`) and `checks`, each with `id`, `name`, `status` (`pass`, `fail`, `warn` or `info`), `points`, `maxPoints` and `details`.

## If it doesn't work

- **"Path must be within the current working directory"**: `scan` only reads inside the directory the server was started in. Start the server from your project, or pass a path under it.
- **The tools don't appear**: check that `npx -y prodlint-mcp` starts in a terminal (it waits silently for a client; Ctrl+C to stop), and that Node is 18 or later.

## More

- Setup guide and what each tool returns: [prodlint.com/mcp](https://prodlint.com/mcp)
- Rules: [prodlint.com/rules](https://prodlint.com/rules)
- The CLI, the GitHub Action and the full rule list: the [main README](https://github.com/prodlint/prodlint#readme)
- MCP registry name: `io.github.prodlint/prodlint`

MIT
