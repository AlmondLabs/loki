/**
 * The phone's Catch Up deck, the pure half — no DOM, so test/deck.test.ts runs it under bun:
 * when a drag becomes a swipe and which way it commits, how far a card leans and how strongly the
 * reveal shows, what this pass has done, and which cards the deck must not show again.
 */
import type { AttentionItem } from "../../../packages/core/src/attention/model.ts";
import { catchUpQueue, idOf, stampOf } from "../../../packages/core/src/attention/queue.ts";

/** Which way a swipe went: right is "seen", left is "later". */
export type Swipe = "seen" | "later";
/** How a card left the deck this pass. */
export type Via = Swipe | "approve" | "deny";

/** A release past this share of the card's width commits. */
export const COMMIT_FRACTION = 0.4;
/** A flick this fast (px per ms) commits short of the distance, once past the slop. */
export const FLICK_VELOCITY = 0.6;
/** The most a card leans while dragged, in degrees. */
export const MAX_ROTATION = 8;
/** A move shorter than this is a tap or a scroll, not a drag. */
export const DRAG_SLOP = 8;
/** How long the undo pill stays, ms. */
export const UNDO_MS = 6000;
/** The fly-off / spring timing. */
export const FLY_MS = 220;
export const FLY_EASE = "cubic-bezier(.2,.8,.2,1)";

/**
 * What releasing a dragged card does. Approvals go nowhere either way: a decision is the only way
 * off, so the card refuses. Otherwise, past 40 % of the width or a fast flick in the drag's own
 * direction commits; anything shorter springs back (null).
 */
export function swipeDecision(dx: number, width: number, velocity: number, opts: { approval: boolean }): Swipe | null {
  if (opts.approval) return null;
  if (!Number.isFinite(dx) || !Number.isFinite(width) || width <= 0) return null;
  const dir: Swipe = dx > 0 ? "seen" : "later";
  if (Math.abs(dx) >= width * COMMIT_FRACTION) return dir;
  if (Math.abs(dx) > DRAG_SLOP && Math.abs(velocity) >= FLICK_VELOCITY && Math.sign(velocity) === Math.sign(dx)) return dir;
  return null;
}

/** A horizontal drag has begun when the finger has moved more sideways than up, and past the slop. */
export function isHorizontalDrag(dx: number, dy: number): boolean {
  return Math.abs(dx) > Math.abs(dy) && Math.abs(dx) > DRAG_SLOP;
}

/** How far the card leans for a drag: 8° at the commit distance, never more. */
export function rotationFor(dx: number, width: number): number {
  if (!(width > 0)) return 0;
  const r = (dx / (width * COMMIT_FRACTION)) * MAX_ROTATION;
  return Math.max(-MAX_ROTATION, Math.min(MAX_ROTATION, r));
}

/** How strongly the reveal under the card shows: full at the commit distance. */
export function revealOpacity(dx: number, width: number): number {
  if (!(width > 0)) return 0;
  return Math.max(0, Math.min(1, Math.abs(dx) / (width * COMMIT_FRACTION)));
}

/** Approvals do not swipe: the card follows the finger a little, with resistance, then springs back. */
export function refusedOffset(dx: number): number {
  const eased = dx * 0.25;
  return Math.max(-40, Math.min(40, eased));
}

/** The px per ms of the last stretch of a drag, from the sample at least `window` ms back. */
export function velocityOf(samples: { x: number; t: number }[], window = 60): number {
  if (samples.length < 2) return 0;
  const last = samples[samples.length - 1];
  let ref = samples[0];
  for (let i = samples.length - 2; i >= 0; i--) {
    ref = samples[i];
    if (last.t - ref.t >= window) break;
  }
  const dt = last.t - ref.t;
  return dt > 0 ? (last.x - ref.x) / dt : 0;
}

/** Where the card behind the top one sits: a touch smaller, a touch lower, dimmer. Two hints, twelve pixels in all. */
export function stackPose(index: number): { scale: number; offsetY: number; opacity: number } {
  if (index <= 0) return { scale: 1, offsetY: 0, opacity: 1 };
  if (index === 1) return { scale: 0.97, offsetY: 6, opacity: 0.7 };
  return { scale: 0.94, offsetY: 12, opacity: 0.45 };
}

/** What this pass has done, for the "n of N" and the end screen. */
export interface PassSummary {
  seen: number;
  later: number;
  approved: number;
  denied: number;
}
export const EMPTY_PASS: PassSummary = { seen: 0, later: 0, approved: 0, denied: 0 };

/** Count one card leaving (delta 1) or coming back by undo (delta -1). */
export function tally(s: PassSummary, via: Via, delta = 1): PassSummary {
  const key = via === "seen" ? "seen" : via === "later" ? "later" : via === "approve" ? "approved" : "denied";
  return { ...s, [key]: Math.max(0, s[key] + delta) };
}

export function passTotal(s: PassSummary): number {
  return s.seen + s.later + s.approved + s.denied;
}

/** "4 seen · 1 deferred · 2 approved" — only the parts that happened; "" when nothing did. */
export function summaryLine(s: PassSummary): string {
  const parts: string[] = [];
  if (s.seen) parts.push(`${s.seen} seen`);
  if (s.later) parts.push(`${s.later} deferred`);
  if (s.approved) parts.push(`${s.approved} approved`);
  if (s.denied) parts.push(`${s.denied} denied`);
  return parts.join(" · ");
}

/**
 * Cards dismissed this session, by "agentId/conversationId" → the stamp at the time. A card stays
 * hidden while its stamp holds; a new reply or a new approval changes the stamp and it shows again,
 * the way the desktop deck re-queues "back" items.
 */
export type Dismissed = Map<string, string>;

export function dismiss(d: Dismissed, item: AttentionItem): Dismissed {
  const next = new Map(d);
  next.set(idOf(item), stampOf(item));
  return next;
}

export function restore(d: Dismissed, item: AttentionItem): Dismissed {
  const next = new Map(d);
  next.delete(idOf(item));
  return next;
}

/** The queue minus what was dismissed and has not moved on since. */
export function visibleQueue(queue: AttentionItem[], dismissed: Dismissed): AttentionItem[] {
  return queue.filter((i) => dismissed.get(idOf(i)) !== stampOf(i));
}

/**
 * Drop dismissals the live list has outgrown. An entry only bridges the round trip: once the seen
 * marker or the snooze has landed the item is out of the actionable queue on its own, and the entry
 * goes — so a snooze that lapses or is cleared brings the card back. It also goes when the item is
 * gone or its stamp changed.
 */
export function pruneDismissed(d: Dismissed, items: AttentionItem[]): Dismissed {
  const live = new Map(catchUpQueue(items).map((i) => [idOf(i), stampOf(i)]));
  const next: Dismissed = new Map();
  for (const [id, stamp] of d) if (live.get(id) === stamp) next.set(id, stamp);
  return next;
}

/**
 * Keep the card under your thumb where it is while the list re-sorts: the pinned id, if still in
 * the queue, comes first; the rest keep their order. An undone card is pinned the same way.
 */
export function toFront(queue: AttentionItem[], id: string | null): AttentionItem[] {
  if (!id) return queue;
  const i = queue.findIndex((it) => idOf(it) === id);
  if (i <= 0) return queue;
  return [queue[i], ...queue.slice(0, i), ...queue.slice(i + 1)];
}
