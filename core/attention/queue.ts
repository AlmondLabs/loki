import type { AttentionItem, AttentionStatus } from "./model.ts";
import { byScore } from "./priority.ts";

const ACTIONABLE: AttentionStatus[] = ["approval", "question", "failed", "done"];
export const idOf = (i: AttentionItem) => `${i.agentId}/${i.id}`;
/**
 * What about this item you would be deciding on. Keyed on content — the last
 * thing the agent said and the pending approval — not on timestamps: turn
 * boundaries, streaming and list refreshes all move `lastMessageAt` without
 * anything new to read, and would bounce a decided card straight back.
 */
export const stampOf = (i: AttentionItem) => `${i.lastAssistantText ?? ""}|${i.pendingApproval?.requestId ?? ""}|${i.pendingQuestion?.requestId ?? ""}|${i.error ?? ""}|${i.turns}`;

/** The ready queue: every card that can be acted on now, in the order the items came (buildItems stamps and sorts by score). */
export function catchUpQueue(items: AttentionItem[], includeSnoozed = false): AttentionItem[] {
  return items.filter((i) => ACTIONABLE.includes(i.status) && (includeSnoozed || !i.snooze));
}

/** The wait queue: actionable items currently hidden by a deferral. */
export function snoozedItems(items: AttentionItem[]): AttentionItem[] {
  return items.filter((i) => ACTIONABLE.includes(i.status) && !!i.snooze);
}

export interface Decision {
  item: AttentionItem;
  action: "seen" | "unread";
  /** How the card was cleared, for the pass summary. */
  via?: "next" | "later" | "approve" | "deny";
  /** stampOf(item) when decided; the same conversation comes back if it has moved on since. */
  stamp: string;
  /** Whether snoozed cards were shown when this was decided; "show snoozed" only revisits cards deferred while they were hidden. */
  snoozedShown?: boolean;
}

/** The head is popped: the card under your hands is done with, and the rest are ordered again by their score. */
export function popHead(queue: AttentionItem[]): AttentionItem[] {
  return byScore(queue.slice(1));
}

/**
 * Fold live items into an open pass, on every event: the head (index 0) never moves; items no
 * longer actionable drop out; everything behind the head — what was there and what just arrived —
 * is ordered by score. A conversation decided earlier in this pass comes back if it has a newer
 * message or a new approval, so a reply that lands while the deck is open is queued rather than
 * lost until the next ⌘⇧K; being warm and yours, it lands right behind the head.
 */
export function mergeQueue(queue: AttentionItem[], items: AttentionItem[], decided: Decision[], includeSnoozed = false): AttentionItem[] {
  const actionable = catchUpQueue(items, includeSnoozed);
  const actionableIds = new Set(actionable.map(idOf));
  const lastDecision = new Map<string, Decision>();
  for (const d of decided) lastDecision.set(idOf(d.item), d); // last decision wins
  const keep = queue.filter((i, idx) => idx === 0 || actionableIds.has(idOf(i)));
  const known = new Set(keep.map(idOf));
  const fresh = actionable.filter((i) => {
    const id = idOf(i);
    if (known.has(id)) return false;
    const prev = lastDecision.get(id);
    if (!prev || prev.stamp !== stampOf(i)) return true;
    // "Show snoozed" is an explicit request to revisit cards deferred earlier in this pass while
    // snoozed cards were hidden. A card deferred with them already shown was just sent away: keep it
    // out, or every "later" would loop it straight back.
    return includeSnoozed && !!i.snooze && prev.via === "later" && !prev.snoozedShown;
  });
  const next = keep.length ? [keep[0], ...byScore([...keep.slice(1), ...fresh])] : byScore(fresh);
  // The kept items are the queue's own objects, so identity says whether anything moved.
  const same = next.length === queue.length && next.every((i, idx) => i === queue[idx]);
  return same ? queue : next;
}
