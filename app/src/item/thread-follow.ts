import type { TranscriptRow } from "../../../core/attention/transcript.ts";
import { REVEAL_PX, revealStart } from "../chat/transcript-window";

const SCREENS_AHEAD = 5;
export const REST_MS = 150;

export function nextAbove(
  view: { scrollTop: number; clientHeight: number },
  at: { hiddenAbove: boolean; olderToAsk: boolean },
): "far" | "reveal" | "older" | null {
  if (view.clientHeight === 0 || view.scrollTop >= Math.max(REVEAL_PX, SCREENS_AHEAD * view.clientHeight)) return "far";
  if (at.hiddenAbove) return "reveal";
  return at.olderToAsk ? "older" : null;
}

export interface Scheduler<T> {
  set: (run: () => void, ms: number) => T;
  clear: (timer: T) => void;
}

export function restTimer<T>(atRest: () => void, scheduler: Scheduler<T>) {
  let timer: T | null = null;
  const stop = () => {
    if (timer !== null) scheduler.clear(timer);
    timer = null;
  };
  return {
    moved: () => {
      stop();
      timer = scheduler.set(() => {
        timer = null;
        atRest();
      }, REST_MS);
    },
    moving: () => timer !== null,
    stop,
  };
}

export function revealFrom(from: number) {
  return <W extends { start: number }>(w: W): W => (w.start === from ? { ...w, start: revealStart(from) } : w);
}

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

export function lastShown(rows: readonly TranscriptRow[]): TranscriptRow | null {
  for (let i = rows.length - 1; i >= 0; i--) if (!rows[i].queued) return rows[i];
  return null;
}

export function drawnRows(rows: TranscriptRow[]): TranscriptRow[] {
  return rows.some((r) => r.queued) ? rows.filter((r) => !r.queued) : rows;
}

export function newSince(rows: readonly TranscriptRow[], from: number): number {
  return rows.slice(from).filter((r) => r.role === "user" || r.role === "assistant").length;
}
