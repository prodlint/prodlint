import { allChecks, type CheckContext, type WebScanResult } from "./checks.js";

export type { WebScanResult, ScanCheck, CheckContext } from "./checks.js";

function getGrade(score: number) {
  if (score >= 80) return "A";
  if (score >= 60) return "B";
  if (score >= 40) return "C";
  if (score >= 20) return "D";
  return "F";
}

function getDomain(url: string) {
  try { return new URL(url).hostname; } catch { return url; }
}

const PRIVATE_HOSTNAMES = new Set(["localhost", "127.0.0.1", "0.0.0.0", "[::1]", "metadata.google.internal"]);

export function isPrivateHost(hostname: string): boolean {
  if (PRIVATE_HOSTNAMES.has(hostname.toLowerCase())) return true;
  const h = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (h === "::1" || h.startsWith("fe80:") || h.startsWith("fc") || h.startsWith("fd") || h === "::") return true;
  const ipv4 = hostname.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4) {
    const [, a, b] = ipv4.map(Number);
    if (a === 10 || a === 127 || a === 0) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    if (a === 198 && (b === 18 || b === 19)) return true;
  }
  return false;
}

function validateRedirectUrl(responseUrl: string): boolean {
  try {
    const parsed = new URL(responseUrl);
    return !isPrivateHost(parsed.hostname);
  } catch { return false; }
}

async function fetchText(url: string, timeout = 8000): Promise<string | null> {
  try {
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), timeout);
    const r = await fetch(url, { signal: c.signal, headers: { "User-Agent": "Prodlint-WebScanner/1.0" }, redirect: "follow" });
    clearTimeout(t);
    if (r.url && !validateRedirectUrl(r.url)) return null;
    return r.ok ? await r.text() : null;
  } catch { return null; }
}

async function fetchHeaders(url: string, timeout = 8000): Promise<Record<string, string>> {
  try {
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), timeout);
    const r = await fetch(url, { signal: c.signal, headers: { "User-Agent": "Prodlint-WebScanner/1.0" }, redirect: "follow" });
    clearTimeout(t);
    if (r.url && !validateRedirectUrl(r.url)) return {};
    const h: Record<string, string> = {};
    r.headers.forEach((v, k) => { h[k.toLowerCase()] = v; });
    return h;
  } catch { return {}; }
}

async function fetchWithTiming(url: string, timeout = 15000): Promise<{ html: string | null; loadTimeMs: number | null }> {
  try {
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), timeout);
    const start = Date.now();
    const r = await fetch(url, { signal: c.signal, headers: { "User-Agent": "Prodlint-WebScanner/1.0" }, redirect: "follow" });
    const html = await r.text();
    clearTimeout(t);
    if (r.url && !validateRedirectUrl(r.url)) return { html: null, loadTimeMs: null };
    return r.ok ? { html, loadTimeMs: Date.now() - start } : { html: null, loadTimeMs: null };
  } catch { return { html: null, loadTimeMs: null }; }
}

/** Normalize a user-provided URL: add https:// if missing, extract origin. */
export function normalizeUrl(input: string): string {
  let url = input.trim();
  if (!/^https?:\/\//i.test(url)) {
    url = `https://${url}`;
  }
  const parsed = new URL(url);
  return parsed.origin;
}

export async function runWebScan(targetUrl: string): Promise<WebScanResult> {
  const domain = getDomain(targetUrl);
  const [robotsTxt, llmsTxt, aiTxt, tdmRep, agentCard, sitemapXml, httpSigDirectory, headers, pageData] = await Promise.all([
    fetchText(`${targetUrl}/robots.txt`),
    fetchText(`${targetUrl}/llms.txt`),
    fetchText(`${targetUrl}/ai.txt`),
    fetchText(`${targetUrl}/.well-known/tdmrep.json`),
    fetchText(`${targetUrl}/.well-known/agent-card.json`),
    fetchText(`${targetUrl}/sitemap.xml`),
    fetchText(`${targetUrl}/.well-known/http-message-signatures-directory`),
    fetchHeaders(targetUrl),
    fetchWithTiming(targetUrl),
  ]);

  const ctx: CheckContext = { url: targetUrl, domain, robotsTxt, llmsTxt, aiTxt, tdmRep, agentCard, sitemapXml, httpSigDirectory, headers, html: pageData.html, loadTimeMs: pageData.loadTimeMs };
  const checks = allChecks.map(fn => fn(ctx));
  const totalPoints = checks.reduce((s, c) => s + c.points, 0);
  const maxPoints = checks.reduce((s, c) => s + c.maxPoints, 0);
  const overallScore = maxPoints > 0 ? Math.round((totalPoints / maxPoints) * 100) : 0;

  return {
    url: targetUrl, domain, scannedAt: new Date().toISOString(),
    overallScore, grade: getGrade(overallScore), checks,
    summary: {
      passed: checks.filter(c => c.status === "pass").length,
      failed: checks.filter(c => c.status === "fail").length,
      warnings: checks.filter(c => c.status === "warn").length,
      totalChecks: checks.length,
    },
  };
}
