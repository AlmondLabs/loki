/**
 * Search's matching and ranking, for any kind of hit: the phone's Search (phone/searchIndex.ts) and the
 * desktop's ⌘K build their own hits, routes and named pages and hand them here as entries. Pure, so
 * test/shared-search.test.ts runs it under bun.
 *
 * Ranking is one rule: the best tier any field reaches (exact, prefix, word start, substring), a title
 * (the first field) before a secondary field at the same tier, then the newest, then the order given.
 */

/** Past this a query is cut: nothing loki names is longer, and it bounds the history too. */
export const MAX_QUERY = 80;

/** The query as typed, tidied for display and history: trimmed, runs of space as one, at most MAX_QUERY. */
export function cleanQuery(raw: string): string {
  return raw.replace(/\s+/g, " ").trim().slice(0, MAX_QUERY).trim();
}

/** For comparing: cleaned, lower case, accents folded (so "cafe" finds "Café"). */
function fold(s: string): string {
  return s.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase();
}
export const normalize = (raw: string): string => fold(cleanQuery(raw));

const WORD = /[\p{L}\p{N}]/u;

/** A field as it is compared: whitespace collapsed, folded. Done once per field when the index is built. */
const foldField = (text: string): string => fold(text.replace(/\s+/g, " ").trim());

/** How well `text` holds `q`: 0 the whole of it, 1 its start, 2 a word's start, 3 anywhere; null not at all. */
export const tierOf = (text: string, q: string): 0 | 1 | 2 | 3 | null => tierIn(foldField(text), normalize(q));

/** tierOf on a folded field and a normalized query: what each keystroke runs, with nothing refolded. */
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

/** One searchable thing: the hit a caller draws, the fields it matches on (title first), and how recent it is (ms, 0 unknown). */
export interface Indexed<H> {
  hit: H;
  fields: string[];
  recency: number;
}

/** Entries with their fields folded: build once per sources, query per keystroke. */
export type SearchIndex<H> = { readonly entries: readonly Indexed<H>[] };

export function buildSearchIndex<H>(entries: readonly Indexed<H>[]): SearchIndex<H> {
  return { entries: entries.map((e) => ({ ...e, fields: e.fields.map(foldField) })) };
}

/** Title fields weigh first at the same tier: score = tier × this + the field's index (0 title, then the rest). */
const FIELD_SPAN = 100;

/** Every hit that matches, best first; a blank query is none. */
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

/** A kind of hit, as drawn: its title, how many matched, and the first few. */
export interface HitGroup<H, G extends string> {
  id: G;
  title: string;
  /** How many matched; `hits` holds the first `max`. */
  total: number;
  hits: H[];
}

/** Ranked hits into groups, in a fixed order, empty ones left out, each keeping the rank order. */
export function groupHits<H, G extends string>(hits: readonly H[], groupOf: (h: H) => G, order: readonly G[], titles: Record<G, string>, max: number): HitGroup<H, G>[] {
  const groups: HitGroup<H, G>[] = [];
  for (const id of order) {
    const all = hits.filter((h) => groupOf(h) === id);
    if (all.length) groups.push({ id, title: titles[id], total: all.length, hits: all.slice(0, max) });
  }
  return groups;
}
