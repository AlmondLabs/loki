import { defineExtension, defineTool, type Extension } from "@earendil-works/pi-durable";

/**
 * Web search (plan 017, U12): DuckDuckGo's plain HTML results, which need no key and are what Letta Code's web_search
 * used. A result is its title, link and snippet; the tool keeps the first few.
 */

export type SearchResult = { title: string; url: string; snippet: string };

const ENTITIES: Record<string, string> = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#x27;": "'", "&#39;": "'", "&nbsp;": " " };
const plain = (html: string) =>
  html
    .replace(/<[^>]+>/g, "")
    .replace(/&(?:amp|lt|gt|quot|#x27|#39|nbsp);/g, (e) => ENTITIES[e] ?? e)
    .replace(/&#(\d+);/g, (_m, n: string) => String.fromCodePoint(Number(n)))
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
    const link = block.match(/<a[^>]+class="[^"]*result__a[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/) ?? block.match(/<a[^>]+href="([^"]+)"[^>]+class="[^"]*result__a[^"]*"[^>]*>([\s\S]*?)<\/a>/);
    if (!link) continue;
    const snippet = block.match(/class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/(?:a|div|td)>/);
    const url = realUrl(link[1]);
    if (url.includes("duckduckgo.com/y.js")) continue; // an ad's tracker
    out.push({ title: plain(link[2]), url, snippet: snippet ? plain(snippet[1]) : "" });
  }
  return out;
}

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

export function webSearchExtension(search: (query: string, signal?: AbortSignal) => Promise<SearchResult[]> = webSearch): Extension {
  return defineExtension({
    name: "loki.web",
    tools: [
      defineTool({
        name: "web_search",
        description: "Search the web; you get titles, links and short snippets of the top results.",
        parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } as never,
        execute: async (args, _api, context) => {
          const query = (args as { query: string }).query;
          const results = await search(query, context.abortSignal);
          const text = results.length ? results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}${r.snippet ? `\n   ${r.snippet}` : ""}`).join("\n") : `No results from duckduckgo for: ${query}`;
          return { content: [{ type: "text", text }] };
        },
      }),
    ],
  });
}
