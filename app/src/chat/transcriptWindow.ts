import type { TranscriptRow } from "../../../core/attention/transcript.ts";

/**
 * The transcript's window: a long thread mounts only its newest rows, and reveals older ones a chunk at a
 * time as the reader nears the top of what is mounted. Mounting all 420 rows of a long thread, markdown and
 * all, cost a 900 ms task on a slow phone. The window is one number, the first row mounted (`start`); the
 * rest of the thread keeps its indexes, so the New line, widget rows and keys are the thread's own.
 */

/** How many of the newest rows a thread opens with. */
export const WINDOW = 60;
/** How many older rows each reveal adds above. */
export const CHUNK = 20;
/** Rows kept above the New line when the window stretches to reach it, so the line follows something. */
export const DIVIDER_LEAD = 3;
/** Within this many pixels of the top of what is mounted, the next chunk is revealed. */
export const REVEAL_PX = 800;

/** Where a thread opens: its newest WINDOW rows, stretched up to the New line when that is older. */
export function openStart(length: number, dividerAt: number | null = null): number {
  const base = Math.max(0, length - WINDOW);
  return dividerAt === null ? base : Math.max(0, Math.min(base, dividerAt - DIVIDER_LEAD));
}

/** One chunk further up. */
export function revealStart(start: number): number {
  return Math.max(0, start - CHUNK);
}

/**
 * The start as the rows change: rows arriving at the bottom leave it where it is, a thread that got shorter
 * still shows its newest rows, and a New line above the window pulls it up. It never moves down on its own.
 */
export function keepStart(start: number, length: number, dividerAt: number | null): number {
  return Math.min(start, openStart(length, dividerAt));
}

/** After rows were added above, the offset that keeps the row being read where it was. */
export function anchorTop(prevTop: number, prevHeight: number, nextHeight: number): number {
  return prevTop + (nextHeight - prevHeight);
}

/** Which thread the rows are: another first row is another thread (the Catch Up card that changed under one Thread). */
export function threadId(rows: readonly TranscriptRow[] | undefined): string {
  const r = rows?.[0];
  return r ? `${r.role}\u0000${r.at ?? ""}\u0000${r.text.slice(0, 80)}` : "";
}

/** Text as find compares it: no case, no markdown marks, runs of space as one. */
const plain = (s: string) => s.replace(/[*_`~#>|\\[\]]/g, "").replace(/\s+/g, " ").trim().toLowerCase();

/**
 * Find runs on the browser's own text search, which only sees mounted rows: the start that mounts the oldest
 * row (or widget row) whose text holds the query, or `start` when nothing above the window does. Matched on
 * the markdown with its marks stripped, so "**north** region" is found by "north region".
 */
export function findStart(rows: readonly TranscriptRow[], start: number, query: string, marks: ReadonlyArray<{ before: number; who: string; change: string; title: string }> = []): number {
  const q = plain(query);
  if (!q) return start;
  let at = start;
  for (const m of marks) if (m.before < at && plain(`${m.who} ${m.change} ${m.title}`).includes(q)) at = m.before;
  for (let i = 0; i < at; i++) {
    const r = rows[i];
    if (plain([r.text, r.summary, r.detail].filter(Boolean).join(" ")).includes(q)) return i;
  }
  return at;
}
