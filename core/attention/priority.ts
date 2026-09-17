import type { AttentionItem } from "./model.ts";

/**
 * The inbox as a scheduler's ready queue: one number per card, one ordered list, no bands.
 *
 *   score = blocked ? 100 : 0     an approval, a question, a failed turn — an agent is stopped
 *         + warm    ?  10 : 0     the agent spoke under four minutes ago: its prompt is still cached
 *         + yours   ?   5 : 0     the turn answers a person, not a scheduled task's prompt
 *         + blocked ? +0.1 · hours waiting     the agent that has waited longest comes first
 *                   : −0.1 · hours old         everything else drifts down, never up
 *
 * Blocked agents dwarf everything else. Warm replies to you come next: the provider keeps a prompt
 * cached five minutes from its last use, so a reply typed while the card is warm costs a tenth of one
 * typed later, which re-reads the whole conversation. Then colder replies, then reports nobody asked
 * for (a cron's digest, a background job). Age only settles ties and lets old cards drift down — an
 * answer ignored for three days is worth less, not more, and its cache is cold either way — except for
 * a stopped agent, the one case where waiting makes a card more urgent. The score is stamped on every
 * item once per rebuild (buildItems, on each event and the half-minute clock), so the deck, the phone
 * and the card's label all read the same instant. Deferred cards are the wait queue (snooze.ts); they
 * re-enter here when due or when their content changes, at their natural score.
 */
export const BLOCKED_POINTS = 100;
export const WARM_POINTS = 10;
export const YOURS_POINTS = 5;
export const AGE_POINTS_PER_HOUR = 0.1;
export const WAITING_POINTS_PER_HOUR = 0.1;
/** Anthropic's prompt cache lives five minutes from its last use; four leaves time to read and type. */
export const WARM_MS = 4 * 60_000;

/** Who sent the last message into a conversation: a person, or Letta's scheduler firing a cron. */
export type AskedBy = "person" | "schedule";

/** The largest term of a card's score: the one word that explains its place in the list. */
export type Reason = "blocked" | "warm" | "reply" | "report";
export const REASON_LABEL: Record<Reason, string> = { blocked: "", warm: "warm", reply: "reply to you", report: "report" };

/** An item before its score and reason are stamped. */
export type Unscored = Omit<AttentionItem, "score" | "reason">;

export const isBlocked = (i: Unscored): boolean => i.status === "approval" || i.status === "question" || i.status === "failed";
export const isWarm = (i: Unscored, now = Date.now()): boolean => !!i.lastMessageAt && now - new Date(i.lastMessageAt).getTime() < WARM_MS;
/** The agent's last turn answered a person: someone, not a schedule, spoke last before it. */
export const isYours = (i: Unscored): boolean => i.lastRole === "assistant" && i.lastAsk === "person";

export function scoreOf(i: Unscored, now = Date.now()): number {
  const hours = i.lastMessageAt ? Math.max(0, now - new Date(i.lastMessageAt).getTime()) / 3_600_000 : 0;
  const blocked = isBlocked(i);
  return (blocked ? BLOCKED_POINTS : 0) + (isWarm(i, now) ? WARM_POINTS : 0) + (isYours(i) ? YOURS_POINTS : 0) + (blocked ? WAITING_POINTS_PER_HOUR : -AGE_POINTS_PER_HOUR) * hours;
}

export function reasonOf(i: Unscored, now = Date.now()): Reason {
  if (isBlocked(i)) return "blocked";
  if (isWarm(i, now)) return "warm";
  if (isYours(i)) return "reply";
  return "report";
}

/** Highest stamped score first; a stable sort, so equal scores keep the order they came in. */
export function byScore<T extends { score: number }>(items: readonly T[]): T[] {
  return items.map((item, index) => ({ item, index })).sort((a, b) => b.item.score - a.item.score || a.index - b.index).map((x) => x.item);
}

/** Stamp every item's score and reason at one instant, then order them. */
export function scored(items: readonly Unscored[], now = Date.now()): AttentionItem[] {
  return byScore(items.map((i) => ({ ...i, score: scoreOf(i, now), reason: reasonOf(i, now) })));
}
