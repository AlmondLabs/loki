import type { IconName } from "./icons";

export const MAX_QUERY = 80;

export const GROUP_MAX = 5;

export type Lead = { agent: { id: string; name: string } } | { icon: IconName };

export const timeOf = (iso: string | null | undefined): number => {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(t) ? t : 0;
};

export const WAITS: Record<string, string> = { approval: "needs approval", question: "asked you", failed: "failed", done: "finished" };

export function cleanQuery(raw: string): string {
  return raw.replace(/\s+/g, " ").trim().slice(0, MAX_QUERY).trim();
}

function fold(s: string): string {
  return s.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase();
}
export const normalize = (raw: string): string => fold(cleanQuery(raw));

const WORD = /[\p{L}\p{N}]/u;

const foldField = (text: string): string => fold(text.replace(/\s+/g, " ").trim());

export const tierOf = (text: string, q: string): 0 | 1 | 2 | 3 | null => tierIn(foldField(text), normalize(q));

function tierIn(t: string, n: string): 0 | 1 | 2 | 3 | null {
  if (!n) return null;
  if (t === n) return 0;
  let at = t.indexOf(n);
  if (at < 0) return null;
  if (at === 0) return 1;
  while (at >= 0) {
    if (!WORD.test(t[at - 1]) || !WORD.test(t[at])) return 2;
    at = t.indexOf(n, at + 1);
  }
  return 3;
}

export interface Indexed<H> {
  hit: H;
  fields: string[];
  recency: number;
}

export interface SearchIndex<H> {
  readonly entries: ReadonlyArray<Indexed<H>>;
}

export function buildSearchIndex<H>(entries: ReadonlyArray<Indexed<H>>): SearchIndex<H> {
  return { entries: entries.map((e) => ({ ...e, fields: e.fields.map(foldField) })) };
}

const FIELD_SPAN = 100;

export function rankHits<H>(idx: SearchIndex<H>, raw: string): H[] {
  const q = normalize(raw);
  if (!q) return [];
  const scored: Array<{ e: Indexed<H>; score: number; index: number }> = [];
  idx.entries.forEach((e, index) => {
    let score = Infinity;
    e.fields.forEach((f, fi) => {
      const t = f ? tierIn(f, q) : null;
      if (t !== null) score = Math.min(score, t * FIELD_SPAN + Math.min(fi, 1));
    });
    if (score !== Infinity) scored.push({ e, score, index });
  });
  scored.sort((a, b) => a.score - b.score || b.e.recency - a.e.recency || a.index - b.index);
  return scored.map((s) => s.e.hit);
}

export interface HitGroup<H, G extends string> {
  id: G;
  title: string;
  total: number;
  hits: H[];
}

export function groupHits<H, G extends string>(
  hits: readonly H[],
  groupOf: (h: H) => G,
  order: readonly G[],
  titles: Record<G, string>,
  max: number,
): Array<HitGroup<H, G>> {
  const groups: Array<HitGroup<H, G>> = [];
  for (const id of order) {
    const all = hits.filter((h) => groupOf(h) === id);
    if (all.length) groups.push({ id, title: titles[id], total: all.length, hits: all.slice(0, max) });
  }
  return groups;
}
