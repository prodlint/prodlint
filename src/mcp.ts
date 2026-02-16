import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
// prodlint-disable-next-line hallucinated-imports
import { z } from 'zod'
import { scan } from './scanner.js'
import { getVersion } from './utils/version.js'

const server = new McpServer({
  name: 'prodlint',
  version: getVersion(),
})

server.tool(
  'scan',
  'Scan a project for production readiness issues. Returns a 0-100 score with findings across security, reliability, performance, and AI quality categories.',
  {
    path: z.string().describe('Absolute path to the project directory to scan'),
    ignore: z.array(z.string()).optional().describe('Glob patterns to ignore'),
  },
  async ({ path, ignore }) => {
    const result = await scan({ path, ignore })

    const summary = [
      `## Production Readiness Score: ${result.overallScore}/100`,
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
  console.error('Prodlint MCP server error:', err)
  process.exit(1)
})
