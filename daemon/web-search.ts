import { defineExtension, defineTool, type Extension } from "@earendil-works/pi-durable";
import { withKind } from "./tool-kinds.ts";

/**
 * Web search (plan 017, U12): DuckDuckGo's plain HTML results, which need no key and are what Letta Code's web_search
 * used. A result is its title, link and snippet; the tool keeps the first few.
 */

/** One search result: `url` is the real address, not DuckDuckGo's redirect, and `snippet` is empty when the page had none. */
export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

const ENTITIES: Record<string, string> = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#x27;": "'", "&#39;": "'", "&nbsp;": " " };
/** A numeric entity's character; one past Unicode (a malformed page) stays as written rather than throwing. */
const codePoint = (n: number, entity: string) => (Number.isInteger(n) && n >= 0 && n <= 0x10ffff ? String.fromCodePoint(n) : entity);
const plain = (html: string) =>
  html
    .replace(/<[^>]+>/g, "")
    .replace(/&(?:amp|lt|gt|quot|#x27|#39|nbsp);/g, (e) => ENTITIES[e] ?? e)
    .replace(/&#(\d+);/g, (m, n: string) => codePoint(Number(n), m))
    .replace(/&#x([0-9a-f]+);/gi, (m, n: string) => codePoint(Number.parseInt(n, 16), m))
    .replace(/\s+/g, " ")
    .trim();

/** DuckDuckGo wraps each link in a redirect (`/l/?uddg=<url>`): the real address. */
function realUrl(href: string): string {
  const decoded = href.replace(/&amp;/g, "&");
  try {
    const u = new URL(decoded, "https://duckduckgo.com");
    return u.searchParams.get("uddg") ?? u.href;
  } catch {
    return decoded;
  }
}

/** The results in a DuckDuckGo HTML page, ads left out. */
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
    if (url.includes("duckduckgo.com/y.js")) continue; // an ad's tracker
    out.push({ title: plain(link[2]), url, snippet: snippet ? plain(snippet[1]) : "" });
  }
  return out;
}

/** Search DuckDuckGo for `query`: its first eight results, in plain text. Throws when the page does not come back. */
export async function webSearch(query: string, signal?: AbortSignal): Promise<SearchResult[]> {
  const response = await fetch("https://html.duckduckgo.com/html/", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", "user-agent": "Mozilla/5.0 (Macintosh) loki" },
    body: new URLSearchParams({ q: query }).toString(),
    signal,
  });
  if (!response.ok) throw new Error(`the search failed: ${response.status} ${response.statusText}`);
  return parseResults(await response.text());
}

/** The `web_search` tool, as an extension; `search` stands in for DuckDuckGo in tests. */
export function webSearchExtension(search: (query: string, signal?: AbortSignal) => Promise<SearchResult[]> = webSearch): Extension {
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
              : `No results from duckduckgo for: ${query}`;
            return { content: [{ type: "text", text }] };
          },
        }),
      ),
    ],
  });
}
