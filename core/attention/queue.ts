import type { MailAddressing } from "../frame-types.ts";
import type { AttentionItem, AttentionStatus } from "./model.ts";
import { byScore } from "./priority.ts";

/** What needs you: an agent stopped on you, a failed turn, or something new from the agent. The badges count these. */
const NEEDS_YOU: AttentionStatus[] = ["approval", "question", "failed", "done"];
/** A card's identity in the Inbox and a visit's decisions: "agentId/conversationId". */
export const idOf = (i: AttentionItem) => `${i.agent_id}/${i.id}`;
/** An outside card's content stamp: its newest message, so the mod can tell a rest from it alone (plan 078). */
export const outsideStamp = (newestMessageId: string) => `outside|${newestMessageId}`;

/**
 * What about this item you would be deciding on. Keyed on content — the last
 * thing the agent said and the pending approval — not on timestamps: turn
 * boundaries, streaming and list refreshes all move `lastMessageAt` without
 * anything new to read, and would bounce a decided card straight back. Nor on
 * turns counted live: rests keep the stamp on the Mac for every device, and a
 * count each client starts at 0 ended a rest made on another, or before a reload.
 * A turn that leaves the last words as they were is not something new. An outside card's stamp is its newest
 * message's id.
 */
export const stampOf = (i: AttentionItem) =>
  // An outside card's content is its newest message (plan 067, R11): a new one ends its rest, its text alone never does.
  i.outside
    ? outsideStamp(i.outside.newest_message_id)
    : `${i.lastAssistantText ?? ""}|${i.pendingApproval?.requestId ?? ""}|${i.pendingQuestion?.requestId ?? ""}|${i.error ?? ""}`;

/**
 * What needs you now: the count on the Inbox's badge, Home's "Needs your attention", Search's waiting group.
 * In the order the items came (buildItems stamps and sorts by score).
 */
export function catchUpQueue(items: AttentionItem[]): AttentionItem[] {
  return items.filter((i) => NEEDS_YOU.includes(i.status));
}

/**
 * The Inbox: every chat you have not archived (a chat is not done until it is archived; the list the mod hands
 * over already leaves archived ones out), except one whose agent is mid-turn, where there is nothing for you to
 * do yet, and one Next has rested (rest.ts) until it is due or something new comes; `resting` lets those in too,
 * once you ask to go through them. Ranked by score, so what needs you comes first (priority.ts).
 */
export function inboxQueue(items: AttentionItem[], resting = false): AttentionItem[] {
  return items.filter((i) => i.status !== "running" && (resting || !i.resting));
}

/** How many cards rest: what the end of a pass offers to go through. */
export function restingCount(items: AttentionItem[]): number {
  return items.filter((i) => i.status !== "running" && i.resting).length;
}

/** What you did with one card on an Inbox visit, kept so the visit can summarise itself and bring a card back when its chat moves on. */
export interface Decision {
  item: AttentionItem;
  /**
   * Next (⌘]) marks the card read and moves on; Archive is done, and the card leaves the Inbox; Later (⌘[) leaves it
   * unread and puts it off (plan 070, R6); Label put Gmail labels on an email card, which stays for the next key (R12).
   */
  action: "seen" | "archived" | "later" | "label";
  /** How the card went, for the visit's summary. */
  via?: "next" | "later" | "archive" | "label" | "approve" | "deny";
  /** stampOf(item) when decided; the same conversation comes back if it has moved on since. */
  stamp: string;
  /** The card's row in the list when it was decided, so undo puts it back there (R9); absent, it goes back on top. */
  at?: number;
  /**
   * A mail reply still held for its undo (plan 076): the id it is stopped by, and the words and addressing that come
   * back to the box when it is. Gone once the reply went, so undo then takes back the move as usual.
   */
  held?: { outbox_id: string; text: string; mail: MailAddressing | null };
}

/** What a merge pins and lets in: the selected card's id, which stays wherever it sits, and whether resting cards count. */
export interface MergeOptions {
  /** Going through the cards Next rested, asked for at the end of a pass. */
  resting?: boolean;
  /** "agentId/conversationId" of the selected card, or null with nothing selected. */
  selectedId?: string | null;
}

/**
 * Fold live items into an open visit, on every event (plan 2026-11-14-1330, KTD5, R8). The rows never reorder within a
 * visit: chats that left the Inbox (archived, or their agent started a turn) drop out and close the gap, and the rest
 * keep their places. The selected card stays even when it has left, so a card answered elsewhere does not vanish from
 * under the person (R11). What arrives is placed by score among the rows under the selection, never above it, so the
 * rows the person has passed never move. A chat moved past earlier in this visit comes back only if it has a newer
 * message or a new approval, so a reply that lands while the deck is open is queued rather than waiting for the next
 * visit. Scoring is priority.ts's; only entering, a lane switch and Go Through Them sort the rows afresh.
 */
export function mergeQueue(
  queue: AttentionItem[],
  items: AttentionItem[],
  decided: Decision[],
  { resting = false, selectedId = null }: MergeOptions = {},
): AttentionItem[] {
  const actionable = inboxQueue(items, resting);
  const actionableIds = new Set(actionable.map(idOf));
  const lastDecision = new Map<string, Decision>();
  for (const d of decided) lastDecision.set(idOf(d.item), d); // last decision wins
  const keep = queue.filter((i) => idOf(i) === selectedId || actionableIds.has(idOf(i)));
  const known = new Set(keep.map(idOf));
  const fresh = actionable.filter((i) => {
    const id = idOf(i);
    if (known.has(id)) return false;
    const prev = lastDecision.get(id);
    return prev?.stamp !== stampOf(i);
  });
  const next = placeArrivals(
    keep,
    byScore(fresh),
    keep.findIndex((i) => idOf(i) === selectedId),
  );
  // The kept items are the queue's own objects, so identity says whether anything moved.
  const same = next.length === queue.length && next.every((i, idx) => i === queue[idx]);
  return same ? queue : next;
}

/** Each arrival (highest score first) goes under row `floor`, before the first row it outscores, so equal scores keep their order. */
function placeArrivals(rows: AttentionItem[], arrivals: AttentionItem[], floor: number): AttentionItem[] {
  const next = [...rows];
  for (const item of arrivals) {
    let at = floor + 1;
    while (at < next.length && next[at].score >= item.score) at++;
    next.splice(at, 0, item);
  }
  return next;
}

/**
 * The rows once the selection leaves the card `leftId`: a card held only because it was selected (answered or archived
 * elsewhere, R11) goes now; one still in the Inbox stays where it is.
 */
export function leaveRow(queue: AttentionItem[], leftId: string, items: AttentionItem[], resting = false): AttentionItem[] {
  if (inboxQueue(items, resting).some((i) => idOf(i) === leftId)) return queue;
  const next = queue.filter((i) => idOf(i) !== leftId);
  return next.length === queue.length ? queue : next;
}
