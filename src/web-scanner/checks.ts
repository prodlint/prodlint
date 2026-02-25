export type CheckStatus = "pass" | "fail" | "warn" | "info";
export type CheckSeverity = "critical" | "high" | "medium" | "low";

export type CheckMaturity = "established" | "emerging";

export interface ScanCheck {
  id: string;
  name: string;
  description: string;
  status: CheckStatus;
  severity: CheckSeverity;
  maturity: CheckMaturity;
  points: number;
  maxPoints: number;
  details?: string;
}

export interface CheckContext {
  url: string;
  domain: string;
  robotsTxt: string | null;
  llmsTxt: string | null;
  aiTxt: string | null;
  tdmRep: string | null;
  agentCard: string | null;
  sitemapXml: string | null;
  httpSigDirectory: string | null;
  headers: Record<string, string>;
  html: string | null;
  loadTimeMs: number | null;
}

export interface ScanResult {
  url: string;
  domain: string;
  scannedAt: string;
  overallScore: number;
  grade: string;
  checks: ScanCheck[];
  summary: { passed: number; failed: number; warnings: number; totalChecks: number };
}

function make(
  id: string, name: string, description: string, maxPoints: number,
  severity: CheckSeverity, maturity: CheckMaturity, status: CheckStatus, details: string
): ScanCheck {
  return {
    id, name, description, status, severity, maturity, details,
    points: status === "pass" ? maxPoints : status === "warn" ? Math.floor(maxPoints / 2) : 0,
    maxPoints,
  };
}

function checkRobotsTxt(ctx: CheckContext): ScanCheck {
  if (!ctx.robotsTxt) return make("robots_txt", "robots.txt", "robots.txt exists and is accessible", 7, "medium", "established", "fail", "No robots.txt found.");
  return make("robots_txt", "robots.txt", "robots.txt exists and is accessible", 7, "medium", "established", "pass", "robots.txt found.");
}

function checkRobotsAiDirectives(ctx: CheckContext): ScanCheck {
  if (!ctx.robotsTxt) return make("robots_ai_directives", "AI robots.txt Directives", "AI bot user-agents in robots.txt", 15, "critical", "established", "fail", "No robots.txt found. AI bots have no guidance.");
  const agents = ["GPTBot", "ChatGPT-User", "ClaudeBot", "Claude-Web", "Google-Extended", "PerplexityBot", "Bytespider", "CCBot", "anthropic-ai", "cohere-ai", "Applebot-Extended", "Grok"];
  const found = agents.filter(a => ctx.robotsTxt!.toLowerCase().includes(a.toLowerCase()));
  if (found.length === 0) return make("robots_ai_directives", "AI robots.txt Directives", "AI bot user-agents in robots.txt", 15, "critical", "established", "fail", "No AI-specific user-agent directives found.");
  if (found.length < 3) return make("robots_ai_directives", "AI robots.txt Directives", "AI bot user-agents in robots.txt", 15, "critical", "established", "warn", `Found ${found.length} AI bot directive(s): ${found.join(", ")}.`);
  return make("robots_ai_directives", "AI robots.txt Directives", "AI bot user-agents in robots.txt", 15, "critical", "established", "pass", `Found ${found.length} AI bot directive(s): ${found.join(", ")}.`);
}

function checkContentUsage(ctx: CheckContext): ScanCheck {
  const hasHeader = ctx.headers["content-usage"] != null;
  const hasInRobots = ctx.robotsTxt?.toLowerCase().includes("content-usage") ?? false;
  if (!hasHeader && !hasInRobots) return make("content_usage", "Content-Usage (IETF aipref)", "Content-Usage header or directives", 5, "high", "emerging", "fail", "No Content-Usage directives found.");
  return make("content_usage", "Content-Usage (IETF aipref)", "Content-Usage header or directives", 5, "high", "emerging", "pass", hasHeader ? `Header: ${ctx.headers["content-usage"]}` : "Found in robots.txt.");
}

function checkLlmsTxt(ctx: CheckContext): ScanCheck {
  if (!ctx.llmsTxt) return make("llms_txt", "llms.txt", "LLM-optimized site summary at /llms.txt", 6, "high", "emerging", "fail", "No llms.txt found.");
  const lines = ctx.llmsTxt.split("\n").filter(l => l.trim().length > 0 && !l.trim().startsWith("#"));
  if (lines.length < 3) return make("llms_txt", "llms.txt", "LLM-optimized site summary at /llms.txt", 6, "high", "emerging", "warn", "llms.txt found but appears minimal.");
  return make("llms_txt", "llms.txt", "LLM-optimized site summary at /llms.txt", 6, "high", "emerging", "pass", `llms.txt found with ${lines.length} content lines.`);
}

function checkTdmRep(ctx: CheckContext): ScanCheck {
  const hasWK = ctx.tdmRep != null;
  const hasHeader = ctx.headers["tdm-reservation"] != null;
  if (!hasWK && !hasHeader) return make("tdmrep", "TDMRep (W3C)", "Text & data mining reservation file or header", 4, "medium", "emerging", "fail", "No TDMRep configuration found.");
  return make("tdmrep", "TDMRep (W3C)", "Text & data mining reservation file or header", 4, "medium", "emerging", "pass", hasWK ? "/.well-known/tdmrep.json found." : `TDM-Reservation header: ${ctx.headers["tdm-reservation"]}`);
}

function checkAiDisclosure(ctx: CheckContext): ScanCheck {
  if (!ctx.headers["ai-disclosure"]) return make("ai_disclosure", "AI-Disclosure Header", "Declares AI involvement in content generation", 2, "low", "emerging", "fail", "No AI-Disclosure header found.");
  return make("ai_disclosure", "AI-Disclosure Header", "Declares AI involvement in content generation", 2, "low", "emerging", "pass", `Header: ${ctx.headers["ai-disclosure"]}`);
}

function checkAgentCard(ctx: CheckContext): ScanCheck {
  if (!ctx.agentCard) return make("agent_card", "A2A AgentCard", "/.well-known/agent-card.json for agent discovery", 5, "high", "emerging", "fail", "No A2A AgentCard found.");
  try {
    const card = JSON.parse(ctx.agentCard);
    if (!card.name || !Array.isArray(card.skills) || card.skills.length === 0) return make("agent_card", "A2A AgentCard", "/.well-known/agent-card.json for agent discovery", 5, "high", "emerging", "warn", "AgentCard found but missing name or skills.");
    return make("agent_card", "A2A AgentCard", "/.well-known/agent-card.json for agent discovery", 5, "high", "emerging", "pass", `AgentCard found with ${card.skills.length} skill(s).`);
  } catch {
    return make("agent_card", "A2A AgentCard", "/.well-known/agent-card.json for agent discovery", 5, "high", "emerging", "warn", "AgentCard found but contains invalid JSON.");
  }
}

function checkAiTxt(ctx: CheckContext): ScanCheck {
  if (!ctx.aiTxt) return make("ai_txt", "ai.txt", "AI training permissions per Spawning spec", 3, "medium", "emerging", "fail", "No ai.txt found at site root.");
  const lines = ctx.aiTxt.split("\n").filter(l => l.trim().length > 0 && !l.trim().startsWith("#"));
  if (lines.length < 2) return make("ai_txt", "ai.txt", "AI training permissions per Spawning spec", 3, "medium", "emerging", "warn", "ai.txt found but appears minimal.");
  return make("ai_txt", "ai.txt", "AI training permissions per Spawning spec", 3, "medium", "emerging", "pass", `ai.txt found with ${lines.length} directive(s).`);
}

function checkWebMCP(ctx: CheckContext): ScanCheck {
  if (!ctx.html) return make("webmcp", "WebMCP Tools", "Chrome 146+ WebMCP tool registration", 5, "high", "emerging", "info", "Could not check for WebMCP tools.");
  const hasToolname = /toolname=/i.test(ctx.html);
  const hasModelContext = /navigator\.modelContext/i.test(ctx.html) || /registerTool/i.test(ctx.html);
  if (!hasToolname && !hasModelContext) return make("webmcp", "WebMCP Tools", "Chrome 146+ WebMCP tool registration", 5, "high", "emerging", "fail", "No WebMCP tools detected.");
  const count = (ctx.html.match(/toolname=/gi) || []).length;
  return make("webmcp", "WebMCP Tools", "Chrome 146+ WebMCP tool registration", 5, "high", "emerging", "pass", hasToolname ? `${count} form(s) with toolname attributes.` : "registerTool() usage detected.");
}

function checkStructuredData(ctx: CheckContext): ScanCheck {
  if (!ctx.html) return make("structured_data", "Structured Data", "JSON-LD or Schema.org markup", 12, "medium", "established", "info", "Could not fetch page HTML.");
  const jsonLd = ctx.html.match(/<script[^>]*type=["']application\/ld\+json["'][^>]*>/gi);
  const hasMicrodata = ctx.html.includes("itemscope") && ctx.html.includes("itemtype");
  if (!jsonLd && !hasMicrodata) return make("structured_data", "Structured Data", "JSON-LD or Schema.org markup", 12, "medium", "established", "fail", "No structured data found.");
  return make("structured_data", "Structured Data", "JSON-LD or Schema.org markup", 12, "medium", "established", "pass", `Found ${(jsonLd?.length || 0) + (hasMicrodata ? 1 : 0)} structured data block(s).`);
}

function checkOpenGraph(ctx: CheckContext): ScanCheck {
  if (!ctx.html) return make("opengraph", "OpenGraph & Meta", "OG tags and meta description", 10, "low", "established", "info", "Could not fetch HTML.");
  const checks = [/og:title/i.test(ctx.html), /og:description/i.test(ctx.html), /og:image/i.test(ctx.html), /name=["']description["']/i.test(ctx.html)];
  const passed = checks.filter(Boolean).length;
  if (passed === 0) return make("opengraph", "OpenGraph & Meta", "OG tags and meta description", 10, "low", "established", "fail", "No OpenGraph tags or meta description.");
  if (passed < 3) return make("opengraph", "OpenGraph & Meta", "OG tags and meta description", 10, "low", "established", "warn", `Found ${passed}/4 meta tags.`);
  if (passed < 4) return make("opengraph", "OpenGraph & Meta", "OG tags and meta description", 10, "low", "established", "pass", `Found ${passed}/4 key meta tags.`);
  return make("opengraph", "OpenGraph & Meta", "OG tags and meta description", 10, "low", "established", "pass", "All 4 key meta tags present.");
}

function checkSitemap(ctx: CheckContext): ScanCheck {
  if (!ctx.sitemapXml) return make("sitemap", "sitemap.xml", "Sitemap exists and is valid", 10, "medium", "established", "fail", "No sitemap.xml found.");
  const count = Math.max((ctx.sitemapXml.match(/<url>/gi) || []).length, (ctx.sitemapXml.match(/<loc>/gi) || []).length);
  if (count === 0 && /<sitemapindex/i.test(ctx.sitemapXml)) return make("sitemap", "sitemap.xml", "Sitemap exists and is valid", 10, "medium", "established", "pass", "Sitemap index found.");
  if (count === 0) return make("sitemap", "sitemap.xml", "Sitemap exists and is valid", 10, "medium", "established", "warn", "sitemap.xml found but appears empty.");
  return make("sitemap", "sitemap.xml", "Sitemap exists and is valid", 10, "medium", "established", "pass", `sitemap.xml found with ${count} URL(s).`);
}

function checkHttpSignatures(ctx: CheckContext): ScanCheck {
  const hasDirectory = ctx.httpSigDirectory != null;
  const hasSignatureHeader = ctx.headers["signature"] != null || ctx.headers["signature-input"] != null;
  const hasSignatureAgent = ctx.headers["signature-agent"] != null;
  if (!hasDirectory && !hasSignatureHeader && !hasSignatureAgent) return make("http_signatures", "HTTP Message Signatures (RFC 9421)", "Agent identity verification via cryptographic signatures", 3, "medium", "emerging", "fail", "No HTTP signature support detected.");
  if (hasDirectory) return make("http_signatures", "HTTP Message Signatures (RFC 9421)", "Agent identity verification via cryptographic signatures", 3, "medium", "emerging", "pass", "/.well-known/http-message-signatures-directory found.");
  return make("http_signatures", "HTTP Message Signatures (RFC 9421)", "Agent identity verification via cryptographic signatures", 3, "medium", "emerging", "pass", hasSignatureAgent ? "Signature-Agent header detected." : "Signature/Signature-Input headers detected.");
}

function checkPageSpeed(ctx: CheckContext): ScanCheck {
  if (ctx.loadTimeMs == null) return make("page_speed", "Page Load Time", "Response time for AI agent interactions", 8, "low", "established", "info", "Could not measure.");
  if (ctx.loadTimeMs > 5000) return make("page_speed", "Page Load Time", "Response time for AI agent interactions", 8, "low", "established", "fail", `${(ctx.loadTimeMs / 1000).toFixed(1)}s — agents may time out.`);
  if (ctx.loadTimeMs > 2000) return make("page_speed", "Page Load Time", "Response time for AI agent interactions", 8, "low", "established", "warn", `${(ctx.loadTimeMs / 1000).toFixed(1)}s — consider optimizing.`);
  return make("page_speed", "Page Load Time", "Response time for AI agent interactions", 8, "low", "established", "pass", `${(ctx.loadTimeMs / 1000).toFixed(1)}s.`);
}

export const allChecks = [
  checkRobotsTxt, checkRobotsAiDirectives, checkContentUsage, checkLlmsTxt,
  checkAiTxt, checkTdmRep, checkAiDisclosure, checkAgentCard, checkWebMCP,
  checkHttpSignatures, checkStructuredData, checkOpenGraph, checkSitemap, checkPageSpeed,
];
