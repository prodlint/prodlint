import { describe, it, expect } from 'vitest'
import { allChecks, type CheckContext, type ScanCheck } from '../src/web-scanner/checks.js'

// The Site Score checks themselves. prodlint.com runs a copy of src/web-scanner/checks.ts, and
// the two have to agree or the CLI and the site give the same URL different scores. These pin
// the numbers both are meant to have.

const NOTHING: CheckContext = {
  url: 'https://example.com',
  domain: 'example.com',
  robotsTxt: null,
  llmsTxt: null,
  aiTxt: null,
  tdmRep: null,
  agentCard: null,
  sitemapXml: null,
  httpSigDirectory: null,
  headers: {},
  html: null,
  loadTimeMs: null,
}

function run(overrides: Partial<CheckContext> = {}): Record<string, ScanCheck> {
  const ctx = { ...NOTHING, ...overrides }
  return Object.fromEntries(allChecks.map(check => check(ctx)).map(c => [c.id, c]))
}

describe('Site Score checks', () => {
  it('are 14 checks worth 95 points, 62 of them for established standards', () => {
    const checks = Object.values(run())
    expect(checks).toHaveLength(14)
    expect(new Set(checks.map(c => c.id)).size).toBe(14)

    const points = (maturity: string) => checks.filter(c => c.maturity === maturity).reduce((sum, c) => sum + c.maxPoints, 0)
    expect(points('established')).toBe(62)
    expect(points('emerging')).toBe(33)

    expect(Object.fromEntries(checks.map(c => [c.id, c.maxPoints]))).toEqual({
      robots_txt: 7,
      robots_ai_directives: 15,
      content_usage: 5,
      llms_txt: 6,
      ai_txt: 3,
      tdmrep: 4,
      ai_disclosure: 2,
      agent_card: 5,
      webmcp: 5,
      http_signatures: 3,
      structured_data: 12,
      opengraph: 10,
      sitemap: 10,
      page_speed: 8,
    })
  })

  it('give a partial result half the points, rounded down', () => {
    // Two AI crawlers named is a warning; three is a pass
    const two = run({ robotsTxt: 'User-agent: GPTBot\nAllow: /\n\nUser-agent: ClaudeBot\nAllow: /\n' })
    expect(two.robots_ai_directives).toMatchObject({ status: 'warn', points: 7, maxPoints: 15 })
  })

  it('know the crawler names their operators document today', () => {
    const robotsTxt = ['OAI-SearchBot', 'Claude-User', 'Claude-SearchBot', 'Applebot-Extended', 'Perplexity-User']
      .map(agent => `User-agent: ${agent}\nAllow: /\n`)
      .join('\n')
    const { robots_ai_directives: check } = run({ robotsTxt })
    expect(check.status).toBe('pass')
    expect(check.details).toContain('Found 5 AI bot directive(s)')
  })

  it('see WebMCP tools registered on document.modelContext or navigator.modelContext', () => {
    expect(run({ html: '<html></html>' }).webmcp.status).toBe('fail')
    expect(run({ html: '<script>document.modelContext.registerTool({ name: "x" })</script>' }).webmcp.status).toBe('pass')
    expect(run({ html: '<script>navigator.modelContext.provideContext({})</script>' }).webmcp.status).toBe('pass')
    expect(run({ html: '<form toolname="search"></form>' }).webmcp.details).toBe('1 form(s) with toolname attributes.')
  })

  it("don't count an llms.txt's headings as content", () => {
    expect(run({ llmsTxt: '# Site\n\n## Docs\n\n## Blog\n' }).llms_txt.status).toBe('warn')
    const full = run({ llmsTxt: '# Site\n\n> What it is.\n\n## Docs\n\n- [One](https://example.com/1)\n- [Two](https://example.com/2)\n' })
    expect(full.llms_txt).toMatchObject({ status: 'pass', details: 'llms.txt found with 3 content lines.' })
  })

  it('say how many of the four meta tags a page has', () => {
    const three = '<meta property="og:title" content="t"><meta property="og:description" content="d"><meta name="description" content="d">'
    expect(run({ html: three }).opengraph).toMatchObject({ status: 'pass', details: 'Found 3/4 key meta tags.' })
    expect(run({ html: three + '<meta property="og:image" content="https://example.com/i.png">' }).opengraph.details).toBe('All 4 key meta tags present.')
  })
})
