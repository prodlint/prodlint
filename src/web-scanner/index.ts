import { lookup as dnsLookup } from "node:dns";
import { lookup as dnsLookupAll } from "node:dns/promises";
import { request as httpRequest, type ClientRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { BlockList, isIP, type LookupFunction } from "node:net";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";
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

// Address space no public website lives in: loopback, RFC 1918, link-local (where cloud
// metadata services sit), CGNAT, benchmarking, multicast and reserved.
const PRIVATE_RANGES = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16],
  ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["224.0.0.0", 3],
] as const) PRIVATE_RANGES.addSubnet(network, prefix, "ipv4");
// Unspecified/loopback/IPv4-compatible, local-use NAT64, Teredo, unique local, link-local,
// site-local, multicast.
for (const [network, prefix] of [
  ["::", 96], ["64:ff9b:1::", 48], ["2001::", 32], ["fc00::", 7], ["fe80::", 10], ["fec0::", 10], ["ff00::", 8],
] as const) PRIVATE_RANGES.addSubnet(network, prefix, "ipv6");

/** The eight 16-bit groups of a valid IPv6 address, which may end in a dotted quad. */
function ipv6Groups(address: string): number[] {
  const quad = address.match(/^(.*:)(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  const hex = quad
    ? `${quad[1]}${((+quad[2] << 8) | +quad[3]).toString(16)}:${((+quad[4] << 8) | +quad[5]).toString(16)}`
    : address;
  const [head, tail] = hex.split("::");
  const parse = (part: string | undefined) => (part ? part.split(":").map(g => parseInt(g, 16)) : []);
  const front = parse(head);
  const back = parse(tail);
  return tail === undefined ? front : [...front, ...Array<number>(8 - front.length - back.length).fill(0), ...back];
}

/** The IPv4 address that an IPv4-mapped, NAT64 or 6to4 IPv6 address routes to. */
function embeddedIPv4(address: string): string | null {
  const g = ipv6Groups(address);
  const quad = (hi: number, lo: number) => `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
  const zero = (from: number, to: number) => g.slice(from, to).every(x => x === 0);
  if (zero(0, 5) && g[5] === 0xffff) return quad(g[6], g[7]); // ::ffff:0:0/96
  if (g[0] === 0x64 && g[1] === 0xff9b && zero(2, 6)) return quad(g[6], g[7]); // 64:ff9b::/96
  if (g[0] === 0x2002) return quad(g[1], g[2]); // 2002::/16
  return null;
}

/** True for an IP address in a loopback, private, link-local or otherwise non-public range. */
export function isPrivateAddress(address: string): boolean {
  const ip = address.replace(/^\[|\]$/g, "").replace(/%.*$/, "");
  const family = isIP(ip);
  if (family === 4) return PRIVATE_RANGES.check(ip, "ipv4");
  if (family !== 6) return false;
  const v4 = embeddedIPv4(ip);
  return (v4 !== null && PRIVATE_RANGES.check(v4, "ipv4")) || PRIVATE_RANGES.check(ip, "ipv6");
}

/**
 * True for hostnames that are private by name or are private IP literals. Names that merely
 * resolve to private addresses are caught by resolvesToPrivateAddress, and again at connect time.
 */
export function isPrivateHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.+$/, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".internal")) return true;
  return isPrivateAddress(host);
}

/** True when DNS resolves the hostname to any private address. Lookup failures are left to the scan. */
export async function resolvesToPrivateAddress(hostname: string): Promise<boolean> {
  try {
    const addresses = await dnsLookupAll(hostname.replace(/^\[|\]$/g, ""), { all: true });
    return addresses.some(a => isPrivateAddress(a.address));
  } catch { return false; }
}

// Checks every address at connect time, so a hostname that passed the upfront check can't
// reach a private address through a redirect or a changed DNS answer (rebinding).
export const guardedLookup: LookupFunction = (hostname, options, callback) => {
  dnsLookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return callback(err, "");
    const blocked = addresses.find(a => isPrivateAddress(a.address));
    if (blocked) {
      return callback(Object.assign(new Error(`${hostname} resolves to private address ${blocked.address}`), { code: "EPRIVATEADDR" }), "");
    }
    if (options.all) return callback(null, addresses);
    callback(null, addresses[0].address, addresses[0].family);
  });
};

const USER_AGENT = "Prodlint-WebScanner/1.0";
const MAX_REDIRECTS = 5;
// More than any robots.txt, llms.txt or homepage the checks need to see; the rest is dropped.
const MAX_BODY_BYTES = 5 * 1024 * 1024;

export interface GetResult { status: number; headers: Record<string, string>; body: string }

function flattenHeaders(res: IncomingMessage): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(res.headers)) {
    if (value !== undefined) headers[key] = Array.isArray(value) ? value.join(", ") : value;
  }
  return headers;
}

function readBody(res: IncomingMessage): Promise<string> {
  const encoding = String(res.headers["content-encoding"] ?? "").trim().toLowerCase();
  const decoder = encoding === "gzip" || encoding === "x-gzip" ? createGunzip()
    : encoding === "deflate" ? createInflate()
    : encoding === "br" ? createBrotliDecompress()
    : null;
  const stream = decoder ? res.pipe(decoder) : res;
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const done = () => resolve(Buffer.concat(chunks).toString("utf8"));
    stream.on("data", (chunk: Buffer) => {
      if (size >= MAX_BODY_BYTES) return;
      chunks.push(chunk.subarray(0, MAX_BODY_BYTES - size));
      size += chunk.length;
      if (size >= MAX_BODY_BYTES) { done(); res.destroy(); decoder?.destroy(); }
    });
    stream.on("end", done);
    stream.on("error", reject);
    res.on("error", reject); // pipe() doesn't forward errors from its source
  });
}

/**
 * GET with one deadline covering connect, redirects and the body, a cap on body size, and
 * redirects followed by hand so every hop is re-checked. Resolves null on any failure.
 * Only tests override `lookup`.
 */
export function guardedGet(url: string, timeoutMs: number, lookup: LookupFunction = guardedLookup): Promise<GetResult | null> {
  return new Promise(resolve => {
    let current: ClientRequest | undefined;
    const finish = (result: GetResult | null) => {
      clearTimeout(timer);
      current?.destroy();
      resolve(result);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);

    const attempt = (target: URL, redirectsLeft: number) => {
      if ((target.protocol !== "http:" && target.protocol !== "https:") || isPrivateHost(target.hostname)) return finish(null);
      const send = target.protocol === "https:" ? httpsRequest : httpRequest;
      current = send(target, { agent: false, lookup, headers: { "User-Agent": USER_AGENT, "Accept-Encoding": "gzip, deflate, br" } }, res => {
        const status = res.statusCode ?? 0;
        const location = res.headers.location;
        if (status >= 300 && status < 400 && location) {
          res.resume();
          let next: URL;
          try { next = new URL(location, target); } catch { return finish(null); }
          return redirectsLeft > 0 ? attempt(next, redirectsLeft - 1) : finish(null);
        }
        readBody(res).then(body => finish({ status, headers: flattenHeaders(res), body }), () => finish(null));
      });
      current.on("error", () => finish(null));
      current.end();
    };

    try { attempt(new URL(url), MAX_REDIRECTS); } catch { finish(null); }
  });
}

async function fetchText(url: string, timeout = 8000): Promise<string | null> {
  const r = await guardedGet(url, timeout);
  return r && r.status >= 200 && r.status < 300 ? r.body : null;
}

/** The homepage, fetched once for both its headers and its HTML. */
async function fetchPage(url: string, timeout = 15000): Promise<Pick<CheckContext, "headers" | "html" | "loadTimeMs">> {
  const start = Date.now();
  const r = await guardedGet(url, timeout);
  const ok = r !== null && r.status >= 200 && r.status < 300;
  return { headers: r?.headers ?? {}, html: ok ? r.body : null, loadTimeMs: ok ? Date.now() - start : null };
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
  const [robotsTxt, llmsTxt, aiTxt, tdmRep, agentCard, sitemapXml, httpSigDirectory, page] = await Promise.all([
    fetchText(`${targetUrl}/robots.txt`),
    fetchText(`${targetUrl}/llms.txt`),
    fetchText(`${targetUrl}/ai.txt`),
    fetchText(`${targetUrl}/.well-known/tdmrep.json`),
    fetchText(`${targetUrl}/.well-known/agent-card.json`),
    fetchText(`${targetUrl}/sitemap.xml`),
    fetchText(`${targetUrl}/.well-known/http-message-signatures-directory`),
    fetchPage(targetUrl),
  ]);

  const ctx: CheckContext = { url: targetUrl, domain, robotsTxt, llmsTxt, aiTxt, tdmRep, agentCard, sitemapXml, httpSigDirectory, ...page };
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
