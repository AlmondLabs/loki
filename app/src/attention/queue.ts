import type { AttentionItem, AttentionStatus } from "./model";

const ACTIONABLE: AttentionStatus[] = ["approval", "question", "failed", "done"];
export const idOf = (i: AttentionItem) => `${i.agentId}/${i.id}`;
/**
 * What about this item you would be deciding on. Keyed on content — the last
 * thing the agent said and the pending approval — not on timestamps: turn
 * boundaries, streaming and list refreshes all move `lastMessageAt` without
 * anything new to read, and would bounce a decided card straight back.
 */
export const stampOf = (i: AttentionItem) => `${i.lastAssistantText ?? ""}|${i.pendingApproval?.requestId ?? ""}|${i.pendingQuestion?.requestId ?? ""}|${i.error ?? ""}|${i.turns}`;

export function catchUpQueue(items: AttentionItem[], includeSnoozed = false): AttentionItem[] {
  return items.filter((i) => ACTIONABLE.includes(i.status) && (includeSnoozed || !i.snooze));
}

/** Actionable items currently hidden by a deferral. */
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
}

/**
 * Fold live items into an open pass. The current card (index 0) never moves;
 * items no longer actionable drop out; new ones join at the end — including a
 * conversation decided earlier in this pass if it has a newer message or a new
 * approval, so a reply that comes back while the deck is open is queued rather
 * than lost until the next ⌘⇧K.
 */
export function mergeQueue(queue: AttentionItem[], items: AttentionItem[], decided: Decision[], includeSnoozed = false): AttentionItem[] {
  const actionable = catchUpQueue(items, includeSnoozed);
  const actionableIds = new Set(actionable.map(idOf));
  const decidedStamp = new Map<string, string>();
  for (const d of decided) decidedStamp.set(idOf(d.item), d.stamp); // last decision wins
  const keep = queue.filter((i, idx) => idx === 0 || actionableIds.has(idOf(i)));
  const known = new Set(keep.map(idOf));
  const fresh = actionable.filter((i) => {
    const id = idOf(i);
    if (known.has(id)) return false;
    const prev = decidedStamp.get(id);
    return prev === undefined || prev !== stampOf(i);
  });
  return fresh.length || keep.length !== queue.length ? [...keep, ...fresh] : queue;
}
