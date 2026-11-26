import { defineExtension, defineTool, type Extension } from "@earendil-works/pi-durable";
import { fenceThread } from "../mod/account-ops/fence.ts";
import { withKind } from "./tool-kinds.ts";

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

export interface WebFetchResult {
  url: string;
  contentType: string;
  text: string;
  truncated: boolean;
}

const AD_TRACKER = "duckduckgo.com/y.js";
const CHALLENGE_PATTERNS = [/anomaly-modal/i, /bots use duckduckgo/i, /unfortunately,\s*bots/i];
const ENTITIES: Record<string, string> = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#x27;": "'", "&#39;": "'", "&nbsp;": " " };
const codePoint = (n: number, entity: string) => (Number.isInteger(n) && n >= 0 && n <= 0x10ffff ? String.fromCodePoint(n) : entity);
const decodeEntities = (html: string) =>
  html
    .replace(/&(?:amp|lt|gt|quot|#x27|#39|nbsp);/g, (e) => ENTITIES[e] ?? e)
    .replace(/&#(\d+);/g, (m, n: string) => codePoint(Number(n), m))
    .replace(/&#x([0-9a-f]+);/gi, (m, n: string) => codePoint(Number.parseInt(n, 16), m));
const plain = (html: string) =>
  decodeEntities(html.replace(/<[^>]+>/g, ""))
    .replace(/\s+/g, " ")
    .trim();

const str = (v: unknown): string => (typeof v === "string" ? v : "");
const rec = (v: unknown): Record<string, unknown> => (typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {});

// Outside (DuckDuckGo): each result link is wrapped in a redirect, `/l/?uddg=<url>`.
function realUrl(href: string): string {
  const decoded = href.replace(/&amp;/g, "&");
  try {
    const u = new URL(decoded, "https://duckduckgo.com");
    return u.searchParams.get("uddg") ?? u.href;
  } catch {
    return decoded;
  }
}

export function parseResults(html: string, limit = 8): SearchResult[] {
  const out: SearchResult[] = [];
  const blocks = html.split(/<div[^>]+class="[^"]*\bresult\b[^"]*"/).slice(1);
  for (const block of blocks) {
    if (out.length >= limit) break;
    if (/result--ad\b/.test(block.slice(0, 200))) continue;
    const link =
      /<a[^>]+class="[^"]*result__a[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/.exec(block) ??
      /<a[^>]+href="([^"]+)"[^>]+class="[^"]*result__a[^"]*"[^>]*>([\s\S]*?)<\/a>/.exec(block);
    if (!link) continue;
    const snippet = /class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/(?:a|div|td)>/.exec(block);
    const url = realUrl(link[1]);
    if (url.includes(AD_TRACKER)) continue;
    out.push({ title: plain(link[2]), url, snippet: snippet ? plain(snippet[1]) : "" });
  }
  return out;
}

async function braveSearch(query: string, apiKey: string, signal?: AbortSignal): Promise<SearchResult[]> {
  const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=8`;
  const response = await fetch(url, {
    headers: { accept: "application/json", "X-Subscription-Token": apiKey },
    signal,
  });
  if (!response.ok) throw new Error(`the search failed: ${response.status} ${response.statusText}`);
  const data = rec(await response.json());
  const raw = Array.isArray(rec(data.web).results) ? (rec(data.web).results as unknown[]) : [];
  return raw.slice(0, 8).flatMap((item): SearchResult[] => {
    const r = rec(item);
    const link = str(r.url);
    return link ? [{ title: str(r.title) || link, url: link, snippet: str(r.description) }] : [];
  });
}

async function tavilySearch(query: string, apiKey: string, signal?: AbortSignal): Promise<SearchResult[]> {
  const response = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ api_key: apiKey, query, max_results: 8 }),
    signal,
  });
  if (!response.ok) throw new Error(`the search failed: ${response.status} ${response.statusText}`);
  const data = rec(await response.json());
  const raw = Array.isArray(data.results) ? (data.results as unknown[]) : [];
  return raw.slice(0, 8).flatMap((item): SearchResult[] => {
    const r = rec(item);
    const link = str(r.url);
    return link ? [{ title: str(r.title) || link, url: link, snippet: str(r.content) }] : [];
  });
}

export async function webSearch(query: string, signal?: AbortSignal): Promise<SearchResult[]> {
  const braveKey = process.env.BRAVE_API_KEY?.trim();
  if (braveKey) return braveSearch(query, braveKey, signal);
  const tavilyKey = process.env.TAVILY_API_KEY?.trim();
  if (tavilyKey) return tavilySearch(query, tavilyKey, signal);
  const response = await fetch("https://html.duckduckgo.com/html/", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", "user-agent": "Mozilla/5.0 (Macintosh) loki" },
    body: new URLSearchParams({ q: query }).toString(),
    signal,
  });
  if (!response.ok) throw new Error(`the search failed: ${response.status} ${response.statusText}`);
  const html = await response.text();
  if (CHALLENGE_PATTERNS.some((p) => p.test(html))) throw new Error("DuckDuckGo returned a bot check: set BRAVE_API_KEY or TAVILY_API_KEY, or try again later");
  return parseResults(html);
}

export function htmlToText(html: string): string {
  const clean = html
    .replace(/<(script|style|noscript|svg)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|section|article|header|footer|aside|main|li|tr|blockquote|pre|h[1-6])>/gi, "\n")
    .replace(/<li\b[^>]*>/gi, "- ")
    .replace(/<h[1-6]\b[^>]*>/gi, "\n");
  return decodeEntities(clean.replace(/<[^>]+>/g, ""))
    .replace(/[ \t\r]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function assertSafeUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`not a valid URL: ${raw}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error(`only http and https URLs are allowed, not ${url.protocol}`);
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (!host || host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal"))
    throw new Error(`refused private host: ${url.hostname}`);
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (ipv4) {
    const [a, b] = [Number(ipv4[1]), Number(ipv4[2])];
    const blocked =
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127);
    if (blocked) throw new Error(`refused private IP: ${url.hostname}`);
  }
  if (
    host === "::" ||
    host === "::1" ||
    host.startsWith("fe80:") ||
    host.startsWith("fc") ||
    host.startsWith("fd") ||
    host.startsWith("::ffff:127.") ||
    host.startsWith("::ffff:10.") ||
    host.startsWith("::ffff:169.254.") ||
    host.startsWith("::ffff:192.168.") ||
    /^::ffff:172\.(1[6-9]|2\d|3[01])\./.test(host) ||
    /^::ffff:(?:7f|0a|a9fe|c0a8|0000):/i.test(host)
  ) {
    throw new Error(`refused private IP: ${url.hostname}`);
  }
  return url;
}

const FETCH_TIMEOUT_MS = 15_000;
const FETCH_MAX_BYTES = 2 * 1024 * 1024;
const FETCH_DEFAULT_CHARS = 12_000;
const FETCH_MAX_CHARS = 40_000;

async function readBounded(response: Response, maxBytes: number): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return (await response.text()).slice(0, maxBytes);
  const chunks: Uint8Array[] = [];
  let total = 0;
  const pull = async (): Promise<void> => {
    const next = await reader.read();
    if (next.done) return;
    const room = maxBytes - total;
    if (next.value.byteLength <= room) {
      chunks.push(next.value);
      total += next.value.byteLength;
      if (total < maxBytes) return pull();
    } else if (room > 0) {
      chunks.push(next.value.subarray(0, room));
      total += room;
    }
    await reader.cancel();
  };
  await pull();
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(joined);
}

export async function webFetch(rawUrl: string, opts: { maxChars?: number; signal?: AbortSignal; fetch?: typeof fetch } = {}): Promise<WebFetchResult> {
  const url = assertSafeUrl(rawUrl);
  const limit = Math.min(Math.max(Math.floor(opts.maxChars ?? FETCH_DEFAULT_CHARS) || FETCH_DEFAULT_CHARS, 200), FETCH_MAX_CHARS);
  const timeout = AbortSignal.timeout(FETCH_TIMEOUT_MS);
  const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
  const response = await (opts.fetch ?? fetch)(url.href, {
    headers: { "user-agent": "Mozilla/5.0 (Macintosh) loki", accept: "text/html,application/xhtml+xml,text/plain,application/json;q=0.9,*/*;q=0.8" },
    redirect: "follow",
    signal,
  });
  assertSafeUrl(response.url || url.href);
  if (!response.ok) throw new Error(`fetch failed: ${response.status} ${response.statusText}`);
  const contentType = (response.headers.get("content-type") ?? "text/plain").split(";")[0].trim().toLowerCase();
  const rawBody = await readBounded(response, FETCH_MAX_BYTES);
  const full = contentType.includes("html") ? htmlToText(rawBody) : rawBody.trim();
  const truncated = full.length > limit;
  return { url: response.url || url.href, contentType, text: truncated ? full.slice(0, limit) : full, truncated };
}

export function webSearchExtension(
  search: (query: string, signal?: AbortSignal) => Promise<SearchResult[]> = webSearch,
  fetcher: (url: string, opts?: { maxChars?: number; signal?: AbortSignal }) => Promise<WebFetchResult> = webFetch,
): Extension {
  return defineExtension({
    name: "loki.web",
    tools: [
      withKind(
        "read",
        defineTool({
          name: "web_search",
          description: "Search the web; you get titles, links and short snippets of the top results.",
          parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } as never,
          execute: async (args, _api, context) => {
            const query = (args as { query: string }).query;
            const results = await search(query, context.abortSignal);
            const text = results.length
              ? results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}${r.snippet ? `\n   ${r.snippet}` : ""}`).join("\n")
              : `No results found for: ${query}`;
            return { output: [{ type: "text", text }] };
          },
        }),
      ),
      withKind(
        "read",
        defineTool({
          name: "web_fetch",
          description: "Fetch an http/https URL and read its extracted text content.",
          parameters: {
            type: "object",
            properties: {
              url: { type: "string", description: "The http or https URL to fetch" },
              max_chars: { type: "integer", description: "Maximum characters to return (default 12000, max 40000)" },
            },
            required: ["url"],
          } as never,
          execute: async (args, _api, context) => {
            const a = args as { url: string; max_chars?: number };
            const res = await fetcher(a.url, { ...(a.max_chars !== undefined ? { maxChars: a.max_chars } : {}), signal: context.abortSignal });
            const fenced = fenceThread([{ sender: res.url, at: "", text: res.text || "(empty response)" }]);
            const text = res.truncated ? `${fenced}\n\n[truncated at ${res.text.length} chars]` : fenced;
            return { output: [{ type: "text", text }] };
          },
        }),
      ),
    ],
  });
}
