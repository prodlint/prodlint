import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import { scan } from './scanner.js'
import { getVersion } from './utils/version.js'
import { runWebScan, normalizeUrl, isPrivateHost } from './web-scanner/index.js'

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

server.tool(
  'scan-web',
  'Check a deployed website\'s AI agent-readiness. Returns a 0-100 score across 14 checks including robots.txt AI directives, llms.txt, AgentCard, WebMCP, and more.',
  { url: z.string().describe('URL of the website to scan (e.g. https://example.com)') },
  async ({ url }) => {
    let normalizedUrl: string
    try {
      normalizedUrl = normalizeUrl(url)
    } catch {
      return {
        content: [{ type: 'text' as const, text: `Error: Invalid URL "${url}"` }],
        isError: true,
      }
    }

    const hostname = new URL(normalizedUrl).hostname
    if (isPrivateHost(hostname)) {
      return {
        content: [{ type: 'text' as const, text: 'Error: Cannot scan private or internal hosts.' }],
        isError: true,
      }
    }

    const result = await runWebScan(normalizedUrl)

    const STATUS_SYMBOLS: Record<string, string> = { pass: '\u2713', fail: '\u2717', warn: '!', info: 'i' }

    const summary = [
      `## Site Score: ${result.overallScore}/100 (${result.grade})`,
      '',
      `Scanned ${result.domain} \u00b7 ${result.summary.totalChecks} checks`,
      '',
      '### Checks',
      ...result.checks.map(c => {
        const sym = STATUS_SYMBOLS[c.status] ?? '?'
        return `- ${sym} **${c.name}** \u2014 ${c.details || 'No details'} (${c.points}/${c.maxPoints})`
      }),
      '',
      `### Summary: ${result.summary.passed} passed \u00b7 ${result.summary.failed} failed \u00b7 ${result.summary.warnings} warnings`,
    ]

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
