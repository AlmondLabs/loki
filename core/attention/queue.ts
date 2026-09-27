import type { AttentionItem, AttentionStatus } from "./model.ts";
import { byScore } from "./priority.ts";

/** What needs you: an agent stopped on you, a failed turn, or something new from the agent. The badges count these. */
const NEEDS_YOU: AttentionStatus[] = ["approval", "question", "failed", "done"];
export const idOf = (i: AttentionItem) => `${i.agentId}/${i.id}`;
/**
 * What about this item you would be deciding on. Keyed on content — the last
 * thing the agent said and the pending approval — not on timestamps: turn
 * boundaries, streaming and list refreshes all move `lastMessageAt` without
 * anything new to read, and would bounce a decided card straight back.
 */
export const stampOf = (i: AttentionItem) => `${i.lastAssistantText ?? ""}|${i.pendingApproval?.requestId ?? ""}|${i.pendingQuestion?.requestId ?? ""}|${i.error ?? ""}|${i.turns}`;

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
 * do yet. Nothing is deferred: moving on (Next) keeps a chat in the Inbox for your next visit. Ranked by score,
 * so what needs you comes first (priority.ts).
 */
export function inboxQueue(items: AttentionItem[]): AttentionItem[] {
  return items.filter((i) => i.status !== "running");
}

export interface Decision {
  item: AttentionItem;
  /** Next marks the chat read and moves on; Archive is done, and the chat leaves the Inbox. */
  action: "seen" | "archived";
  /** How the card went, for the visit's summary. */
  via?: "next" | "archive" | "approve" | "deny";
  /** stampOf(item) when decided; the same conversation comes back if it has moved on since. */
  stamp: string;
}

/** The head is popped: the card under your hands is done with, and the rest are ordered again by their score. */
export function popHead(queue: AttentionItem[]): AttentionItem[] {
  return byScore(queue.slice(1));
}

/**
 * Fold live items into an open visit, on every event: the head (index 0) never moves; chats that left the
 * Inbox (archived, or their agent started a turn) drop out; everything behind the head — what was there and
 * what just arrived — is ordered by score. A chat you moved past earlier in this visit comes back only if it
 * has a newer message or a new approval, so a reply that lands while the deck is open is queued rather than
 * waiting for the next visit; being new, it lands near the top.
 */
export function mergeQueue(queue: AttentionItem[], items: AttentionItem[], decided: Decision[]): AttentionItem[] {
  const actionable = inboxQueue(items);
  const actionableIds = new Set(actionable.map(idOf));
  const lastDecision = new Map<string, Decision>();
  for (const d of decided) lastDecision.set(idOf(d.item), d); // last decision wins
  const keep = queue.filter((i, idx) => idx === 0 || actionableIds.has(idOf(i)));
  const known = new Set(keep.map(idOf));
  const fresh = actionable.filter((i) => {
    const id = idOf(i);
    if (known.has(id)) return false;
    const prev = lastDecision.get(id);
    return !prev || prev.stamp !== stampOf(i);
  });
  const next = keep.length ? [keep[0], ...byScore([...keep.slice(1), ...fresh])] : byScore(fresh);
  // The kept items are the queue's own objects, so identity says whether anything moved.
  const same = next.length === queue.length && next.every((i, idx) => i === queue[idx]);
  return same ? queue : next;
}
