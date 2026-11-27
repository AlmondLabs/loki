import type { TranscriptRow } from "../../../core/attention/transcript.ts";

export const WINDOW = 60;
export const CHUNK = 20;
export const DIVIDER_LEAD = 3;
export const REVEAL_PX = 800;

export function openStart(length: number, dividerAt: number | null = null): number {
  const base = Math.max(0, length - WINDOW);
  return dividerAt === null ? base : Math.max(0, Math.min(base, dividerAt - DIVIDER_LEAD));
}

export function revealStart(start: number): number {
  return Math.max(0, start - CHUNK);
}

export function keepStart(start: number, length: number, dividerAt: number | null): number {
  return Math.min(start, openStart(length, dividerAt));
}

export function anchorTop(prevTop: number, prevHeight: number, nextHeight: number): number {
  return prevTop + (nextHeight - prevHeight);
}

export function threadId(rows: readonly TranscriptRow[] | undefined): string {
  const r = rows?.[0];
  return r ? `${r.role}\u0000${r.at ?? ""}\u0000${r.text.slice(0, 80)}` : "";
}

const plain = (s: string) =>
  s
    .replace(/[*_`~#>|\\[\]]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();

export function findStart(rows: readonly TranscriptRow[], start: number, query: string): number {
  const q = plain(query);
  if (!q) return start;
  for (let i = 0; i < start; i++) {
    const r = rows[i];
    if (plain([r.text, r.summary, r.detail].filter(Boolean).join(" ")).includes(q)) return i;
  }
  return start;
}
