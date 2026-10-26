import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { stat } from 'node:fs/promises'
import { resolve, sep } from 'node:path'
import { scan } from './scanner.js'
import { getVersion } from './utils/version.js'
import { runWebScan, normalizeUrl, isPrivateHost, resolvesToPrivateAddress } from './web-scanner/index.js'
import type { Finding, Severity } from './types.js'

const SEVERITIES = ['critical', 'warning', 'info'] as const
const CATEGORIES = ['security', 'reliability', 'performance', 'ai-quality'] as const
const SEVERITY_RANK: Record<Severity, number> = { critical: 3, warning: 2, info: 1 }

// How many findings `scan` lists unless the caller asks for more. Critical findings are
// listed in full even past this cap, so a folder full of info findings can't crowd them out.
const DEFAULT_MAX_FINDINGS = 30

// Most severe first, then by location, so the findings an agent should fix first lead the list
function bySeverity(a: Finding, b: Finding): number {
  return SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity]
    || (a.file < b.file ? -1 : a.file > b.file ? 1 : 0)
    || a.line - b.line
    || a.column - b.column
}

const server = new McpServer({
  name: 'prodlint',
  version: getVersion(),
})

server.registerTool(
  'scan',
  {
    title: 'Scan a project for production readiness',
    description: 'Check a vibe-coded JS/TS project\'s production readiness. Returns a 0-100 score and findings across security, reliability, performance, and AI quality, most severe first. Every critical finding is always included; use minSeverity, categories, and maxFindings to narrow or widen the rest.',
    inputSchema: {
      path: z.string().describe('Absolute path to the project directory to scan; it must be inside the directory the server runs in'),
      ignore: z.array(z.string()).optional().describe('Glob patterns to ignore'),
      minSeverity: z.enum(SEVERITIES).optional().describe('Only list findings at this severity or higher (default: info, i.e. all)'),
      categories: z.array(z.enum(CATEGORIES)).optional().describe('Only list findings in these categories (default: all)'),
      maxFindings: z.number().int().min(1).max(500).optional()
        .describe(`Maximum number of findings to list (default: ${DEFAULT_MAX_FINDINGS}). Critical findings are always listed, even past this limit.`),
    },
    outputSchema: {
      version: z.string().describe('prodlint version that ran the scan'),
      path: z.string().describe('Directory that was scanned'),
      score: z.number().describe('Overall production-readiness score, 0-100'),
      filesScanned: z.number(),
      durationMs: z.number(),
      categoryScores: z.array(z.object({
        category: z.enum(CATEGORIES),
        score: z.number(),
        findingCount: z.number(),
      })),
      summary: z.object({
        critical: z.number(),
        warning: z.number(),
        info: z.number(),
      }).describe('Counts of all findings, before minSeverity and categories are applied'),
      matched: z.number().describe('Findings that pass the minSeverity and categories filters'),
      omitted: z.number().describe('Matching findings left out because of maxFindings'),
      findings: z.array(z.object({
        ruleId: z.string(),
        severity: z.enum(SEVERITIES),
        category: z.enum(CATEGORIES),
        file: z.string(),
        line: z.number(),
        column: z.number(),
        message: z.string(),
        fix: z.string().optional(),
      })).describe('Matching findings, most severe first'),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async ({ path, ignore, minSeverity = 'info', categories, maxFindings = DEFAULT_MAX_FINDINGS }) => {
    // Validate the path exists and is a directory
    const resolved = resolve(path)

    // Block access outside the current working directory (case-insensitive on Windows)
    const cwd = process.cwd()
    const normalizedResolved = process.platform === 'win32' ? resolved.toLowerCase() : resolved
    const normalizedCwd = process.platform === 'win32' ? cwd.toLowerCase() : cwd
    if (normalizedResolved !== normalizedCwd && !normalizedResolved.startsWith(normalizedCwd + sep)) {
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

    const minRank = SEVERITY_RANK[minSeverity]
    const matching = result.findings
      .filter(f => SEVERITY_RANK[f.severity] >= minRank && (!categories?.length || categories.includes(f.category)))
      .sort(bySeverity)
    const criticalCount = matching.filter(f => f.severity === 'critical').length
    const listed = matching.slice(0, Math.max(maxFindings, criticalCount))
    const omitted = matching.length - listed.length

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

    if (listed.length > 0) {
      const scope = [
        minSeverity !== 'info' ? `${minSeverity} and above` : '',
        categories?.length ? categories.join(', ') : '',
      ].filter(Boolean).join('; ')
      summary.push('', `### Findings${scope ? ` (${scope})` : ''}, most severe first`)
      for (const f of listed) {
        const line = `- **[${f.severity}]** \`${f.ruleId}\` ${f.file}:${f.line} — ${f.message}`
        summary.push(f.fix ? `${line}\n  - _Fix: ${f.fix}_` : line)
      }
      if (omitted > 0) {
        summary.push(`- ...and ${omitted} more. Raise maxFindings, or narrow with minSeverity or categories.`)
      }
    } else if (result.findings.length > 0) {
      summary.push('', 'No findings match the minSeverity and categories filters.')
    }

    return {
      content: [{ type: 'text' as const, text: summary.join('\n') }],
      structuredContent: {
        version: result.version,
        path: result.scannedPath,
        score: result.overallScore,
        filesScanned: result.filesScanned,
        durationMs: result.scanDurationMs,
        categoryScores: result.categoryScores.map(c => ({ category: c.category, score: c.score, findingCount: c.findingCount })),
        summary: result.summary,
        matched: matching.length,
        omitted,
        findings: listed.map(f => ({
          ruleId: f.ruleId,
          severity: f.severity,
          category: f.category,
          file: f.file,
          line: f.line,
          column: f.column,
          message: f.message,
          fix: f.fix,
        })),
      },
    }
  },
)

server.registerTool(
  'scan-web',
  {
    title: 'Score a website\'s AI-agent readiness',
    description: 'Check a deployed website\'s AI agent-readiness. Returns a 0-100 score across 14 checks including robots.txt AI directives, llms.txt, AgentCard, WebMCP, and more.',
    inputSchema: {
      url: z.string().describe('URL of the website to scan (e.g. https://example.com)'),
    },
    outputSchema: {
      url: z.string(),
      domain: z.string(),
      score: z.number().describe('Agent-readiness score, 0-100'),
      grade: z.string(),
      summary: z.object({
        passed: z.number(),
        failed: z.number(),
        warnings: z.number(),
        totalChecks: z.number(),
      }),
      checks: z.array(z.object({
        id: z.string(),
        name: z.string(),
        status: z.enum(['pass', 'fail', 'warn', 'info']),
        points: z.number(),
        maxPoints: z.number(),
        details: z.string().optional(),
      })),
    },
    // Read-only, but it fetches the given site over the network
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
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
    if (isPrivateHost(hostname) || await resolvesToPrivateAddress(hostname)) {
      return {
        content: [{ type: 'text' as const, text: 'Error: Cannot scan private or internal hosts.' }],
        isError: true,
      }
    }

    const result = await runWebScan(normalizedUrl)

    const STATUS_SYMBOLS: Record<string, string> = { pass: '✓', fail: '✗', warn: '!', info: 'i' }

    const summary = [
      `## Site Score: ${result.overallScore}/100 (${result.grade})`,
      '',
      `Scanned ${result.domain} · ${result.summary.totalChecks} checks`,
      '',
      '### Checks',
      ...result.checks.map(c => {
        const sym = STATUS_SYMBOLS[c.status] ?? '?'
        return `- ${sym} **${c.name}** — ${c.details || 'No details'} (${c.points}/${c.maxPoints})`
      }),
      '',
      `### Summary: ${result.summary.passed} passed · ${result.summary.failed} failed · ${result.summary.warnings} warnings`,
    ]

    return {
      content: [{ type: 'text' as const, text: summary.join('\n') }],
      structuredContent: {
        url: result.url,
        domain: result.domain,
        score: result.overallScore,
        grade: result.grade,
        summary: result.summary,
        checks: result.checks.map(c => ({
          id: c.id,
          name: c.name,
          status: c.status,
          points: c.points,
          maxPoints: c.maxPoints,
          details: c.details,
        })),
      },
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
