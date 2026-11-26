import type { MailAddressing } from "../frame-types.ts";
import type { AttentionItem, AttentionStatus } from "./model.ts";
import { byScore } from "./priority.ts";

const NEEDS_YOU: ReadonlySet<AttentionStatus> = new Set(["approval", "question", "failed", "done"]);
export const idOf = (i: AttentionItem) => `${i.agent_id}/${i.id}`;
export const outsideStamp = (newestMessageId: string) => `outside|${newestMessageId}`;

export const stampOf = (i: AttentionItem) =>
  i.outside
    ? outsideStamp(i.outside.newest_message_id)
    : `${i.lastAssistantText ?? ""}|${i.pendingApproval?.requestId ?? ""}|${i.pendingQuestion?.requestId ?? ""}|${i.error ?? ""}`;

export function catchUpQueue(items: AttentionItem[]): AttentionItem[] {
  return items.filter((i) => NEEDS_YOU.has(i.status));
}

export function flowQueue(items: AttentionItem[], resting = false): AttentionItem[] {
  return items.filter((i) => i.status !== "running" && (resting || !i.resting));
}

export function restingCount(items: AttentionItem[]): number {
  return items.filter((i) => i.status !== "running" && i.resting).length;
}

export interface Decision {
  item: AttentionItem;
  action: "seen" | "archived" | "later" | "label";
  via?: "next" | "later" | "archive" | "label" | "approve" | "deny";
  stamp: string;
  at?: number;
  held?: { outbox_id: string; text: string; mail: MailAddressing | null };
}

export interface MergeOptions {
  resting?: boolean;
  selectedId?: string | null;
}

export function mergeQueue(
  queue: AttentionItem[],
  items: AttentionItem[],
  decided: Decision[],
  { resting = false, selectedId = null }: MergeOptions = {},
): AttentionItem[] {
  const actionable = flowQueue(items, resting);
  const actionableIds = new Set(actionable.map(idOf));
  const lastDecision = new Map<string, Decision>();
  for (const d of decided) lastDecision.set(idOf(d.item), d);
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
  const same = next.length === queue.length && next.every((i, idx) => i === queue[idx]);
  return same ? queue : next;
}

function placeArrivals(rows: AttentionItem[], arrivals: AttentionItem[], floor: number): AttentionItem[] {
  const next = [...rows];
  for (const item of arrivals) {
    let at = floor + 1;
    while (at < next.length && next[at].score >= item.score) at++;
    next.splice(at, 0, item);
  }
  return next;
}

export function leaveRow(queue: AttentionItem[], leftId: string, items: AttentionItem[], resting = false): AttentionItem[] {
  if (flowQueue(items, resting).some((i) => idOf(i) === leftId)) return queue;
  const next = queue.filter((i) => idOf(i) !== leftId);
  return next.length === queue.length ? queue : next;
}
