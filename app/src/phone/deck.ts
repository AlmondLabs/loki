/**
 * The phone's Catch Up deck, the pure half — no DOM, so test/deck.test.ts runs it under bun:
 * when a drag becomes a swipe and which way it commits, how far a card leans and how strongly the
 * reveal shows, what this pass has done, and which cards the deck must not show again.
 */
import type { AttentionItem } from "../../../core/attention/model.ts";
import { catchUpQueue, idOf, stampOf } from "../../../core/attention/queue.ts";

/** Which way a swipe went: right is "seen" (Mark as done), left is "later" (Later). */
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

/** "4 marked as read · 1 for later · 2 approved" — only the parts that happened, in the buttons' words; "" when nothing did. */
export function summaryLine(s: PassSummary): string {
  const parts: string[] = [];
  if (s.seen) parts.push(`${s.seen} marked as read`);
  if (s.later) parts.push(`${s.later} for later`);
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

/** Where a card is in the deck: on top (live, draggable), behind (a shell: frame and head only), or flying off. */
export type Role = "top" | "shell" | "leaving";

/**
 * The cards drawn: the one flying off (if any) over the top three of the stack. One keyed list, so a
 * card keeps its DOM node as it goes shell → top → leaving and its transform transitions between poses.
 */
export function cardsToDraw(visible: AttentionItem[], leaving: AttentionItem | null): { item: AttentionItem; role: Role; index: number }[] {
  return [
    ...(leaving ? [{ item: leaving, role: "leaving" as Role, index: -1 }] : []),
    ...visible
      .slice(0, 3)
      .filter((i) => !leaving || idOf(i) !== idOf(leaving))
      .map((item, index) => ({ item, role: (index === 0 ? "top" : "shell") as Role, index })),
  ];
}

// ---- The pass as one state -------------------------------------------------------------------------

/**
 * What a review pass remembers, as one value the parent keeps (useDeck): the cards sent away (until
 * their marker lands), the card on top, the card held because you replied to it, and the tally.
 */
export interface DeckState {
  dismissed: Dismissed;
  /** The card under your thumb stays on top while the list re-sorts beneath it. */
  topId: string | null;
  /**
   * A reply, or an answer, from the card marks it seen and starts the agent, which takes it out of the
   * actionable queue; the card stays in hand anyway until you decide it (Later or Mark as done), so the
   * pass does not jump under the message you just sent. Only ever the top card; gone with the item.
   */
  held: AttentionItem | null;
  pass: PassSummary;
}
export const EMPTY_DECK: DeckState = Object.freeze({ dismissed: new Map(), topId: null, held: null, pass: EMPTY_PASS }) as DeckState;

/** The ways off a card: an approval only by its decision, anything else only by Later or Mark as done. */
export function canCommit(item: AttentionItem, via: Via): boolean {
  return item.pendingApproval ? via === "approve" || via === "deny" : via === "seen" || via === "later";
}

const same = (a: AttentionItem) => (b: AttentionItem) => idOf(a) === idOf(b);

/** The cards in this pass, in order: the queue minus what went, the held card (its live copy) if it left the queue, the top card first. */
export function deckQueue(items: AttentionItem[], s: DeckState): AttentionItem[] {
  const visible = visibleQueue(catchUpQueue(items), s.dismissed);
  const held = s.held ? (items.find(same(s.held)) ?? null) : null;
  return toFront(held && !visible.some(same(held)) ? [held, ...visible] : visible, s.topId);
}

/** A card taken off by one of the four ways; a way it does not have (Later on an approval) changes nothing — the same state comes back. */
export function commitCard(s: DeckState, item: AttentionItem, via: Via): DeckState {
  if (!canCommit(item, via)) return s;
  return { dismissed: dismiss(s.dismissed, item), topId: null, held: null, pass: tally(s.pass, via) };
}

/** Undo: the card returns on top, the tally takes it back, and a card that was held is held again. */
export function undoCard(s: DeckState, item: AttentionItem, via: Via, wasHeld = false): DeckState {
  return { dismissed: restore(s.dismissed, item), topId: idOf(item), held: wasHeld ? item : s.held, pass: tally(s.pass, via, -1) };
}

/** Something went out from the card: keep it in hand (see `held`). */
export function holdCard(s: DeckState, item: AttentionItem): DeckState {
  return { ...s, held: item, topId: idOf(item) };
}

/** After the live list changes: forget dismissals it has outgrown, pin whatever is now on top. The same object when nothing moved. */
export function reconcileDeck(s: DeckState, items: AttentionItem[]): DeckState {
  const pruned = pruneDismissed(s.dismissed, items);
  const dismissed = pruned.size === s.dismissed.size ? s.dismissed : pruned;
  const held = s.held && items.some(same(s.held)) ? s.held : null;
  const next = dismissed === s.dismissed && held === s.held ? s : { ...s, dismissed, held };
  const top = deckQueue(items, next)[0];
  const topId = top ? idOf(top) : null;
  return topId === next.topId ? next : { ...next, topId };
}

// ---- What the card says -----------------------------------------------------------------------------

// Shared with the desktop (shared/thread.ts); the phone keeps its names.
export { dayLabel, unreadBoundary } from "../shared/thread";

/** The line above the card's message box: what the agent is waiting on, or what it is doing after your reply. */
export function cardNotice(item: Pick<AttentionItem, "status" | "agentName">, chat: "idle" | "thinking" | "streaming"): string {
  const who = item.agentName ?? "The agent";
  if (chat === "streaming") return `${who} is writing`;
  if (chat === "thinking" || item.status === "running") return `${who} is working`;
  if (item.status === "approval") return `${who} needs your approval`;
  if (item.status === "question") return `${who} asked you something`;
  if (item.status === "failed") return `${who}'s last turn failed`;
  return `${who} is waiting for your reply`;
}

/**
 * The same line over the full page's box: the card's words while the conversation waits on you, what the
 * agent is doing while it works, and nothing on a quiet conversation.
 */
export function threadNotice(item: Pick<AttentionItem, "status" | "agentName"> | null | undefined, waiting: boolean, chat: "idle" | "thinking" | "streaming", agentName: string | null): string | null {
  if (item && waiting) return cardNotice(item, chat);
  if (chat !== "idle") return cardNotice({ status: "done", agentName: item?.agentName ?? agentName }, chat);
  return null;
}

const DONE: Record<Via, string> = { seen: "Marked as read", later: "Moved to Later", approve: "Approved", deny: "Denied" };

/** What a screen reader hears after a card goes: the outcome, the next card, how many are left. */
export function reviewAnnouncement(via: Via, next: Pick<AttentionItem, "title" | "id"> | undefined, left: number): string {
  if (!next || left <= 0) return `${DONE[via]}. You're caught up.`;
  return `${DONE[via]}. Next: ${next.title ?? next.id}. ${left} left.`;
}
