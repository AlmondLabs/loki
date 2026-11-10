/**
 * The phone's Inbox deck, the pure half — no DOM, so test/deck.test.ts runs it without one:
 * when a drag becomes a swipe and which way it commits, how far a card leans and how strongly the
 * reveal shows, what this visit has done, and which cards the deck must not show again.
 */
import type { AttentionItem } from "../../../core/attention/model.ts";
import { agentLanes, type Lane } from "../../../core/attention/lanes.ts";
import { idOf, inboxQueue, stampOf } from "../../../core/attention/queue.ts";
import type { CardVia, MoveResult } from "../../../core/attention/use-attention.ts";
import { releaseCommits } from "../kit/let-go";

/**
 * Which way a swipe sends a card (plan 070, R10), the same on a chat, an email and a Slack card: "seen" (read: marked
 * read, here and out there, and rested) by a right swipe, "later" (left unread, back after its return time) by a left one.
 */
export type Swipe = "seen" | "later";
/** A move by hand that Undo takes back: a swipe's, or "archive" (done: the card leaves), which has its button only. */
export type Move = Swipe | "archive";
/** How a card left the deck this visit. */
export type Via = Move | "approve" | "deny";

/** A release past this share of the card's width commits. */
export const COMMIT_FRACTION = 0.4;
/** The most a card leans while dragged, in degrees. */
export const MAX_ROTATION = 8;
/** A move shorter than this is a tap or a scroll, not a drag. */
export const DRAG_SLOP = 8;
/** How long the undo pill stays, ms. */
export const UNDO_MS = 6000;
/** How far past the deck's edge a card flies before it is gone, px. */
export const FLY_PAST = 80;

/**
 * What releasing a dragged card does. Approvals go nowhere either way: a decision is the only way off, so the card
 * refuses. A card whose reply box holds text (`typed`) springs back too, so a stray swipe never moves the card out from
 * under a reply not yet sent: Send and the buttons are the way. Otherwise a release commits when its speed (px per ms),
 * projected forward, carries the card past 40 % of the width (kit/let-go.ts): right reads, left is later, and a pull
 * that turns back before it lets go springs back (null). Archiving is too final for a stray swipe, so it has its button alone.
 */
export function swipeDecision(dx: number, width: number, velocity: number, opts: { approval: boolean; typed?: boolean }): Swipe | null {
  if (opts.approval || opts.typed) return null;
  if (!Number.isFinite(dx) || !Number.isFinite(width) || width <= 0 || dx === 0) return null;
  const sign = dx > 0 ? 1 : -1;
  const dir: Swipe = sign > 0 ? "seen" : "later";
  return releaseCommits(dx * sign, velocity * 1000 * sign, width * COMMIT_FRACTION, DRAG_SLOP) ? dir : null;
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

/** The drag has gone far enough that letting go commits: the reveal under the card says so. */
export function armed(dx: number, width: number): boolean {
  return width > 0 && Math.abs(dx) >= width * COMMIT_FRACTION;
}

/**
 * A spring's start velocity for a card let go at `from` (px) moving at `v` (px per ms), heading for `to`:
 * the finger's speed as a share of the distance left, per second (kit/spring.ts). 0 when there is no distance.
 */
export function flingVelocity(from: number, to: number, v: number): number {
  const d = to - from;
  return Math.abs(d) < 1 ? 0 : (v * 1000) / d;
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

/** Where the card behind the top one sits: a touch smaller, a touch lower, dimmer. Two hints, twelve pixels in all. */
export function stackPose(index: number): { scale: number; offsetY: number; opacity: number } {
  if (index <= 0) return { scale: 1, offsetY: 0, opacity: 1 };
  if (index === 1) return { scale: 0.97, offsetY: 6, opacity: 0.7 };
  return { scale: 0.94, offsetY: 12, opacity: 0.45 };
}

/** What this visit has done, for the end screen. */
export interface PassSummary {
  seen: number;
  later: number;
  archived: number;
  approved: number;
  denied: number;
}
/** A pass that has done nothing yet. */
export const EMPTY_PASS: PassSummary = { seen: 0, later: 0, archived: 0, approved: 0, denied: 0 };

const TALLY_KEY: Record<Via, keyof PassSummary> = { seen: "seen", later: "later", archive: "archived", approve: "approved", deny: "denied" };

/** Count one card leaving (delta 1) or coming back by undo (delta -1). */
export function tally(s: PassSummary, via: Via, delta = 1): PassSummary {
  const key = TALLY_KEY[via];
  return { ...s, [key]: Math.max(0, s[key] + delta) };
}

/** How many cards this visit has decided, every way counted. */
export function passTotal(s: PassSummary): number {
  return s.seen + s.later + s.archived + s.approved + s.denied;
}

/** "2 read · 1 later · 1 archived · 2 approved" — only the parts that happened; "" when nothing did. */
export function summaryLine(s: PassSummary): string {
  const parts: string[] = [];
  if (s.seen) parts.push(`${s.seen} read`);
  if (s.later) parts.push(`${s.later} later`);
  if (s.archived) parts.push(`${s.archived} archived`);
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

/** The dismissed cards with `item` added at its current stamp. */
export function dismiss(d: Dismissed, item: AttentionItem): Dismissed {
  const next = new Map(d);
  next.set(idOf(item), stampOf(item));
  return next;
}

/** The dismissed cards without `item`, as an undo puts it back. */
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
  const live = new Map(inboxQueue(items).map((i) => [idOf(i), stampOf(i)]));
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
export function cardsToDraw(visible: AttentionItem[], leaving: AttentionItem | null): Array<{ item: AttentionItem; role: Role; index: number }> {
  return [
    ...(leaving ? [{ item: leaving, role: "leaving" as Role, index: -1 }] : []),
    ...visible
      .slice(0, 3)
      .filter((i) => !leaving || idOf(i) !== idOf(leaving))
      .map((item, index): { item: AttentionItem; role: Role; index: number } => ({ item, role: index === 0 ? "top" : "shell", index })),
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
   * actionable queue; the card stays in hand anyway until you decide it (Read, Later or Archive), so the
   * visit does not jump under the message you just sent. Only ever the top card; gone with the item.
   */
  held: AttentionItem | null;
  pass: PassSummary;
  /** Going through the cards Read and Later rested (core/attention/rest.ts), asked for at the end of the pass. */
  resting: boolean;
}
/** A pass not yet started: nothing dismissed, held or counted. */
export const EMPTY_DECK: DeckState = Object.freeze({ dismissed: new Map(), topId: null, held: null, pass: EMPTY_PASS, resting: false });

/** Go through the rested cards: those moved past in this visit come back too, and the tally carries on. */
export function throughResting(s: DeckState): DeckState {
  return { ...EMPTY_DECK, pass: s.pass, resting: true };
}

/** The ways off a card: an approval only by its decision, anything else by Read, Later or Archive; a main chat cannot be archived. */
export function canCommit(item: AttentionItem, via: Via): boolean {
  if (item.pendingApproval) return via === "approve" || via === "deny";
  return via === "seen" || via === "later" || (via === "archive" && item.id !== "default");
}

const same = (a: AttentionItem) => (b: AttentionItem) => idOf(a) === idOf(b);

/** The cards in this pass, in order: the queue minus what went, the held card (its live copy) if it left the queue, the top card first. */
export function deckQueue(items: AttentionItem[], s: DeckState): AttentionItem[] {
  const visible = visibleQueue(inboxQueue(items, s.resting), s.dismissed);
  const held = s.held ? (items.find(same(s.held)) ?? null) : null;
  return toFront(held && !visible.some(same(held)) ? [held, ...visible] : visible, s.topId);
}

/** A card taken off by one of the five ways; a way it does not have (Later on an approval) changes nothing — the same state comes back. */
export function commitCard(s: DeckState, item: AttentionItem, via: Via): DeckState {
  if (!canCommit(item, via)) return s;
  return { ...s, dismissed: dismiss(s.dismissed, item), topId: null, held: null, pass: tally(s.pass, via) };
}

/** Undo: the card returns on top, the tally takes it back, and a card that was held is held again. */
export function undoCard(s: DeckState, item: AttentionItem, via: Via, wasHeld = false): DeckState {
  return { ...s, dismissed: restore(s.dismissed, item), topId: idOf(item), held: wasHeld ? item : s.held, pass: tally(s.pass, via, -1) };
}

/**
 * Which move on each card still stands, so a write-back that fails late brings the card back only for the move it
 * belongs to: not after Undo took that move back (the card is back already and the tally cleared), and not over a newer
 * move on the same card. `made` numbers a move, `takenBack` forgets the card's, `stands` asks whether a number is current.
 */
export interface MoveLedger {
  made: (id: string) => number;
  takenBack: (id: string) => void;
  stands: (id: string, move: number) => boolean;
}

/** An empty ledger of moves (see `MoveLedger`). */
export function moveLedger(): MoveLedger {
  const standing = new Map<string, number>();
  let next = 0;
  return {
    made: (id) => {
      next += 1;
      standing.set(id, next);
      return next;
    },
    takenBack: (id) => {
      standing.delete(id);
    },
    stands: (id, move) => standing.get(id) === move,
  };
}

/** Something went out from the card: keep it in hand (see `held`). */
export function holdCard(s: DeckState, item: AttentionItem): DeckState {
  return { ...s, held: item, topId: idOf(item) };
}

/**
 * After the live list changes: forget dismissals it has outgrown, pin whatever is now on top. The same object when
 * nothing moved. `items` are the active lane's cards and `all` every card (plan 085, KTD6): a dismissal is weighed
 * against every card, so a card passed over in one lane stays passed over through a switch and back, and the card on
 * top stays on top when the new lane holds it.
 */
export function reconcileDeck(s: DeckState, items: AttentionItem[], all: AttentionItem[] = items): DeckState {
  const pruned = pruneDismissed(s.dismissed, all);
  const dismissed = pruned.size === s.dismissed.size ? s.dismissed : pruned;
  const held = s.held && items.some(same(s.held)) ? s.held : null;
  const next = dismissed === s.dismissed && held === s.held ? s : { ...s, dismissed, held };
  const top = deckQueue(items, next).at(0);
  const topId = top ? idOf(top) : null;
  return topId === next.topId ? next : { ...next, topId };
}

// ---- Lanes (plan 085) ------------------------------------------------------------------------------

/** One entry in the lane sheet: the lane's id ("" is Everything) and its name as the lane has it. */
export interface LaneChoice {
  id: string;
  name: string;
}

/**
 * The lane sheet's entries (R11, KTD5): Everything, the person's lanes, then a built-in lane for each agent with cards
 * in Flow, busiest first, read from every card, not the active lane's. No "new lane": lanes are made on a Mac (R8).
 */
export function laneChoices(lanes: Lane[] | null, all: AttentionItem[]): LaneChoice[] {
  return [{ id: "", name: "Everything" }, ...(lanes ?? []).map(({ id, name }) => ({ id, name })), ...agentLanes(all).map(({ id, name }) => ({ id, name }))];
}

/** Flow's quiet line in a lane (R14): how many cards need the person in other lanes, or null at 0, never a badge. */
export function otherLanesLine(count: number): string | null {
  return count > 0 ? `${count} waiting in other lanes` : null;
}

// ---- What the card says -----------------------------------------------------------------------------

/**
 * The line above the card's message box: what the agent is doing after your reply, or what it wants beyond a reply.
 * None for a plain wait: the box's own "Message atlas" already says it is your turn.
 */
export function cardNotice(item: Pick<AttentionItem, "status" | "agent_name">, chat: "idle" | "thinking" | "streaming"): string | null {
  const who = item.agent_name ?? "The agent";
  if (chat === "streaming") return `${who} is writing`;
  if (chat === "thinking" || item.status === "running") return `${who} is working`;
  if (item.status === "approval") return `${who} needs your approval`;
  if (item.status === "question") return `${who} asked you something`;
  if (item.status === "failed") return `${who}'s last turn failed`;
  return null;
}

/**
 * The same line over the full page's box: the card's words while the conversation waits on you, what the
 * agent is doing while it works, and nothing on a quiet conversation.
 */
export function threadNotice(
  item: Pick<AttentionItem, "status" | "agent_name"> | null | undefined,
  waiting: boolean,
  chat: "idle" | "thinking" | "streaming",
  agentName: string | null,
): string | null {
  if (item && waiting) return cardNotice(item, chat);
  if (chat !== "idle") return cardNotice({ status: "done", agent_name: item?.agent_name ?? agentName }, chat);
  return null;
}

const DONE: Record<Via, string> = { seen: "Marked read", later: "Saved for later", archive: "Archived", approve: "Approved", deny: "Denied" };

/** What a screen reader hears after a card goes: the outcome and the next card. */
export function reviewAnnouncement(via: Via, next: Pick<AttentionItem, "title" | "id"> | undefined, left: number): string {
  if (!next || left <= 0) return `${DONE[via]}. You've been through every chat.`;
  return `${DONE[via]}. Next: ${next.title ?? next.id}.`;
}

// ---- The moves out there ----------------------------------------------------------------------------

/** What the phone's moves need of useAttention (plan 070, U6): read, later, archive and the undo of the last one. */
export interface CardMoves {
  read: (item: AttentionItem, via?: CardVia) => Promise<MoveResult>;
  later: (item: AttentionItem, via?: CardVia, until?: string) => Promise<MoveResult>;
  archive: (item: AttentionItem, via?: CardVia) => Promise<string | null>;
  undo: (item: AttentionItem) => Promise<string | null>;
}

/** How a move went: what the phone says when it failed (the card comes back), and `ask` when Later must first ask when. */
export interface MoveOutcome {
  error: string | null;
  ask: boolean;
}

const FAILED: Record<Move, string> = { seen: "Not marked read", later: "Not saved for later", archive: "Not archived" };

/**
 * Make one move on a card through the shared moves, so a read or a later is written out there as well (Gmail, Slack).
 * `until` (ISO) is the person's pick from the return-time sheet; without it a second Later in a row asks (R7).
 */
export async function makeMove(moves: CardMoves, item: AttentionItem, move: Move, how: "swipe" | "tap", until?: string): Promise<MoveOutcome> {
  const said = (err: string | null) => (err ? `${FAILED[move]}: ${err}` : null);
  if (move === "archive") return { error: said(await moves.archive(item, how)), ask: false };
  const r = move === "seen" ? await moves.read(item, how) : await moves.later(item, how, until);
  return { error: said(r.error), ask: r.ask };
}

/** Take back the last move on a card; resolves to what the phone says when it could not be, or null. */
export async function undoMove(moves: CardMoves, item: AttentionItem): Promise<string | null> {
  const err = await moves.undo(item);
  if (!err) return null;
  // A hand-off cannot be taken back: the thread lives in the agent's chat now.
  return err === "handed off" ? "Handed off, not undone" : `Not undone: ${err}`;
}

/** One answer to "when should it come back?": the words on its button and the moment, ISO. */
export interface ReturnChoice {
  label: string;
  until: string;
}

/** The hour a card put off to another day comes back, local time: the start of a working morning. */
export const MORNING_HOUR = 8;
/** How long "Later today" puts a card off; offered only while that is still today. */
export const LATER_TODAY_MS = 3 * 60 * 60_000;

const morning = (now: Date, days: number) => new Date(now.getFullYear(), now.getMonth(), now.getDate() + days, MORNING_HOUR, 0, 0, 0);

/**
 * The return-time sheet's choices at `now` (R7), counted in the phone's own days: later today (three hours on, while
 * that is still today), tomorrow morning, in 3 days, and next Monday morning.
 */
export function returnChoices(now: Date): ReturnChoice[] {
  const soon = new Date(now.getTime() + LATER_TODAY_MS);
  const today = soon.getDate() === now.getDate() ? [{ label: "Later today", until: soon.toISOString() }] : [];
  // Days to the next Monday: 1..7, so on a Monday it is the one a week on.
  const toMonday = (8 - now.getDay()) % 7 || 7;
  return [
    ...today,
    { label: "Tomorrow", until: morning(now, 1).toISOString() },
    { label: "In 3 days", until: morning(now, 3).toISOString() },
    { label: "Next week", until: morning(now, toMonday).toISOString() },
  ];
}

/** A day picked in the sheet's date field ("YYYY-MM-DD") as that morning, ISO; null when it is not a day after today. */
export function dateChoice(day: string, now: Date): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!m) return null;
  const at = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), MORNING_HOUR, 0, 0, 0);
  return Number.isNaN(at.getTime()) || at.getTime() < morning(now, 1).getTime() ? null : at.toISOString();
}
