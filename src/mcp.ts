import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import { scan } from './scanner.js'
import { getVersion } from './utils/version.js'

const server = new McpServer({
  name: 'prodlint',
  version: getVersion(),
})

server.tool(
  'scan',
  'Check a vibe-coded project\'s production readiness. Returns a 0-100 score with findings across security, reliability, performance, and AI quality categories.',
  {
    path: z.string().describe('Absolute path to the project directory to scan'),
    ignore: z.array(z.string()).optional().describe('Glob patterns to ignore'),
  },
  async ({ path, ignore }) => {
    // Validate the path exists and is a directory
    const resolved = resolve(path)

    // Block access outside the current working directory
    const cwd = process.cwd()
    if (!resolved.startsWith(cwd)) {
      return {
        content: [{ type: 'text' as const, text: `Error: Path must be within the current working directory (${cwd})` }],
        isError: true,
      }
    }
    try {
      const stats = await stat(resolved)
      if (!stats.isDirectory()) {
        return {
          content: [{ type: 'text' as const, text: `Error: ${path} is not a directory` }],
          isError: true,
        }
      }
    } catch {
      return {
        content: [{ type: 'text' as const, text: `Error: ${path} does not exist or is not accessible` }],
        isError: true,
      }
    }

    const result = await scan({ path: resolved, ignore })

    const summary = [
      `## Production Readiness: ${result.overallScore}/100`,
      '',
      `Scanned ${result.filesScanned} files in ${result.scanDurationMs}ms`,
      '',
      '### Category Scores',
      ...result.categoryScores.map(
        c => `- **${c.category}**: ${c.score}/100 (${c.findingCount} issues)`,
      ),
      '',
      `### Summary: ${result.summary.critical} critical, ${result.summary.warning} warnings, ${result.summary.info} info`,
    ]

    if (result.findings.length > 0) {
      summary.push('', '### Findings')
      for (const f of result.findings.slice(0, 30)) {
        summary.push(
          `- **[${f.severity}]** \`${f.ruleId}\` ${f.file}:${f.line} — ${f.message}`,
        )
      }
      if (result.findings.length > 30) {
        summary.push(`- ...and ${result.findings.length - 30} more findings`)
      }
    }

    return {
      content: [{ type: 'text' as const, text: summary.join('\n') }],
    }
  },
)

async function main() {
  const transport = new StdioServerTransport()
  await server.connect(transport)
}

main().catch((err) => {
  console.error('Prodlint MCP server error:', err instanceof Error ? err.message : 'Unknown error')
  process.exit(1)
})
