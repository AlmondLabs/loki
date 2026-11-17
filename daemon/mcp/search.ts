import type { McpTool } from "./servers.ts";

export function words(text: string): string[] {
  return text
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 1 || /\d/.test(w));
}

const params = (schema: Record<string, unknown>): string[] => Object.keys(schema.properties ?? {});

function document(t: McpTool): string[] {
  const name = words(t.name);
  return [
    ...name,
    ...name,
    ...name,
    ...words(t.server),
    ...words(t.server),
    ...words(t.title ?? ""),
    ...words(t.title ?? ""),
    ...words(t.description),
    ...params(t.inputSchema).flatMap(words),
  ];
}

export function selected(query: string, tools: readonly McpTool[]): McpTool[] | null {
  const m = /^select:(.+)$/i.exec(query.trim());
  if (!m) return null;
  const wanted = m[1]
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return wanted.flatMap((w) => {
    const [server, ...rest] = w.includes(".") ? w.split(".") : ["", w];
    const name = rest.join(".");
    return tools.filter((t) => t.key === w || (server ? t.server === server && t.name === name : t.name === name)).slice(0, 1);
  });
}

export const RELATIVE_CUTOFF = 0.5;

export function rank(query: string, tools: readonly McpTool[], limit = 5): McpTool[] {
  const q = [...new Set(words(query))];
  if (!q.length || !tools.length) return [];
  const docs = tools.map(document);
  const avg = docs.reduce((n, d) => n + d.length, 0) / docs.length;
  const df = new Map<string, number>();
  for (const d of docs) for (const w of new Set(d)) df.set(w, (df.get(w) ?? 0) + 1);
  const k1 = 1.2;
  const b = 0.75;
  const scored = docs.map((d, i) => {
    let score = 0;
    for (const w of q) {
      const tf = d.filter((x) => x === w).length;
      if (!tf) continue;
      const idf = Math.log(1 + (docs.length - (df.get(w) ?? 0) + 0.5) / ((df.get(w) ?? 0) + 0.5));
      score += (idf * tf * (k1 + 1)) / (tf + k1 * (1 - b + (b * d.length) / avg));
    }
    return { tool: tools[i], score };
  });
  const best = Math.max(0, ...scored.map((s) => s.score));
  return scored
    .filter((s) => s.score > 0 && s.score >= best * RELATIVE_CUTOFF)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((s) => s.tool);
}
