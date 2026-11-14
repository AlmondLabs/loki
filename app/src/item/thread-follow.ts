import type { TranscriptRow } from "../../../core/attention/transcript.ts";

/**
 * Whether the desktop thread is away from its end. MessageScroller writes `data-scrollable` on its viewport after every
 * scroll and size change, and leaves "end" out of it while it follows the bottom, so this reads its own answer at once.
 */
export function awayFromEnd(el: HTMLElement): boolean {
  return (el.getAttribute("data-scrollable") ?? "").split(" ").includes("end");
}

/** The keys MessageScroller takes for the reader scrolling, which stop it following the bottom. */
const DOWN_KEYS = new Set(["ArrowDown", "End", "PageDown", " "]);

/**
 * Whether a wheel or a key at the bottom should keep the thread following. MessageScroller stops following on any wheel
 * or scroll key, and starts again only on the scroll that brings it back; at the bottom a scroll down moves nothing and
 * fires no scroll, so the next streamed line would leave the reader behind. Only a scroll up, or shift-space, leaves it.
 */
export function keepsFollowing(el: HTMLElement, e: { deltaY: number } | { key: string; shiftKey: boolean }): boolean {
  if (awayFromEnd(el)) return false;
  if ("deltaY" in e) return e.deltaY >= 0;
  return DOWN_KEYS.has(e.key) && !(e.key === " " && e.shiftKey);
}

/** The thread's last row as drawn: queued messages wait in the Composer's queue (plan 097, U6), not in the thread. */
export function lastShown(rows: readonly TranscriptRow[]): TranscriptRow | null {
  for (let i = rows.length - 1; i >= 0; i--) if (!rows[i].queued) return rows[i];
  return null;
}

/**
 * The rows the thread draws: queued messages wait in the Composer's queue (plan 097, U6). The agent's live reply comes
 * after a queued message, so every queued row is left out, not only a trailing run; with none queued, the same list.
 */
export function drawnRows(rows: TranscriptRow[]): TranscriptRow[] {
  return rows.some((r) => r.queued) ? rows.filter((r) => !r.queued) : rows;
}

/**
 * How many messages, yours and the agent's, are drawn from row `from` on, for the jump button's count. `rows` and `from`
 * count drawn rows (drawnRows): a queued row going in before the live reply would otherwise move it past the mark.
 */
export function newSince(rows: readonly TranscriptRow[], from: number): number {
  return rows.slice(from).filter((r) => r.role === "user" || r.role === "assistant").length;
}
