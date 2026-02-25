import { allChecks, type CheckContext, type ScanResult } from "./checks.js";

export type { ScanCheck, CheckContext, ScanResult as WebScanResult } from "./checks.js";

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
  // IPv6-mapped IPv4 (e.g. ::ffff:127.0.0.1, [::ffff:10.0.0.1], bare ::ffff:10.0.0.1)
  const v4mapped = h.match(/^(?:::ffff:)(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4mapped) {
    const [, a, b] = v4mapped.map(Number);
    if (a === 10 || a === 127 || a === 0) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true;
    return false;
  }
  // Octal/hex IPv4 bypass detection (e.g. 0177.0.0.1, 0x7f.0.0.1)
  if (/^(0[xX][0-9a-fA-F]+|0[0-7]+)(\.|$)/.test(hostname)) return true;
  // Decimal IPv4 notation (e.g. 2130706433 = 127.0.0.1)
  if (/^\d+$/.test(hostname)) {
    const dec = parseInt(hostname, 10);
    if (dec >= 0 && dec <= 0xFFFFFFFF) {
      const a = (dec >>> 24) & 0xFF;
      const b = (dec >>> 16) & 0xFF;
      if (a === 10 || a === 127 || a === 0) return true;
      if (a === 172 && b >= 16 && b <= 31) return true;
      if (a === 192 && b === 168) return true;
      if (a === 169 && b === 254) return true;
      if (a === 100 && b >= 64 && b <= 127) return true;
      if (a === 198 && (b === 18 || b === 19)) return true;
    }
  }
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

function isAllowedProtocol(url: string): boolean {
  try {
    const p = new URL(url).protocol;
    return p === "https:" || p === "http:";
  } catch { return false; }
}

function validateRedirectUrl(responseUrl: string): boolean {
  try {
    const parsed = new URL(responseUrl);
    if (!isAllowedProtocol(responseUrl)) return false;
    return !isPrivateHost(parsed.hostname);
  } catch { return false; }
}

const MAX_REDIRECTS = 5;

async function safeFetch(url: string, timeout: number, signal: AbortSignal): Promise<Response | null> {
  let current = url;
  for (let i = 0; i < MAX_REDIRECTS; i++) {
    const r = await fetch(current, { signal, headers: { "User-Agent": "Prodlint-WebScanner/1.0" }, redirect: "manual" });
    const status = r.status;
    if (status >= 300 && status < 400) {
      const location = r.headers.get("location");
      if (!location) return null;
      const resolved = new URL(location, current).toString();
      if (!validateRedirectUrl(resolved)) return null;
      current = resolved;
      continue;
    }
    return r;
  }
  return null; // too many redirects
}

async function fetchText(url: string, timeout = 8000): Promise<string | null> {
  try {
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), timeout);
    const r = await safeFetch(url, timeout, c.signal);
    clearTimeout(t);
    if (!r || !r.ok) return null;
    return await r.text();
  } catch { return null; }
}

async function fetchHeaders(url: string, timeout = 8000): Promise<Record<string, string>> {
  try {
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), timeout);
    const r = await safeFetch(url, timeout, c.signal);
    clearTimeout(t);
    if (!r) return {};
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
    const r = await safeFetch(url, timeout, c.signal);
    clearTimeout(t);
    if (!r || !r.ok) return { html: null, loadTimeMs: null };
    const html = await r.text();
    return { html, loadTimeMs: Date.now() - start };
  } catch { return { html: null, loadTimeMs: null }; }
}

export function normalizeUrl(input: string): string {
  let url = input.trim();
  if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
  const parsed = new URL(url); // throws on invalid
  return parsed.origin;
}

export async function runWebScan(targetUrl: string): Promise<ScanResult> {
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
