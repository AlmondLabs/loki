import type { AttentionItem } from "./model.ts";

/**
 * The inbox as a scheduler's ready queue: one number per card, one ordered list, no bands.
 *
 *   score = blocked ? 100 : 0     an approval, a question, a failed turn — an agent is stopped
 *         + warm    ?  10 : 0     the agent spoke under four minutes ago: its prompt is still cached
 *         + yours   ?   5 : 0     the turn answers a message a person sent, not a scheduled prompt
 *         − 0.1 · hours since the last message
 *
 * Blocked agents dwarf everything else. Warm replies to you come next: the provider keeps a prompt
 * cached five minutes from its last use, so a reply typed while the card is warm costs a tenth of one
 * typed later, which re-reads the whole conversation. Then colder replies, then reports nobody asked
 * for (a cron's digest, a background job). The age term only settles ties and lets old cards drift
 * down; nothing ages upward — an answer ignored for three days is worth less, not more, and its cache
 * is cold either way. Deferred cards are the wait queue (snooze.ts); they re-enter here when due or
 * when their content changes, at their natural score.
 */
export const BLOCKED_POINTS = 100;
export const WARM_POINTS = 10;
export const YOURS_POINTS = 5;
export const AGE_POINTS_PER_HOUR = 0.1;
/** Anthropic's prompt cache lives five minutes from its last use; four leaves time to read and type. */
export const WARM_MS = 4 * 60_000;

/** The last message a person (or a schedule) sent into a conversation, from the log or the live stream. */
export interface LastAsk {
  /** When it was sent; null when the log line carried no time. */
  at: string | null;
  /** A scheduled task's prompt ("Scheduled task "x" is firing."), not a person. */
  scheduled: boolean;
}

/** Letta's scheduler speaks first in a cron turn, always with this opening. */
export const isScheduledPrompt = (text: string): boolean => /^\s*Scheduled task\b/.test(text);

export const isBlocked = (i: AttentionItem): boolean => i.status === "approval" || i.status === "question" || i.status === "failed";
export const isWarm = (i: AttentionItem, now = Date.now()): boolean => !!i.lastMessageAt && now - new Date(i.lastMessageAt).getTime() < WARM_MS;
/** The agent's last turn answered a person: the last thing said before it came from someone, not a schedule. */
export const isYours = (i: AttentionItem): boolean => i.lastRole === "assistant" && !!i.lastAsk && !i.lastAsk.scheduled;

export function scoreOf(i: AttentionItem, now = Date.now()): number {
  const hours = i.lastMessageAt ? Math.max(0, now - new Date(i.lastMessageAt).getTime()) / 3_600_000 : 0;
  return (isBlocked(i) ? BLOCKED_POINTS : 0) + (isWarm(i, now) ? WARM_POINTS : 0) + (isYours(i) ? YOURS_POINTS : 0) - AGE_POINTS_PER_HOUR * hours;
}

/** The largest term of a card's score: the one word that explains its place in the list. */
export type Reason = "blocked" | "warm" | "reply" | "report";
export function reasonOf(i: AttentionItem, now = Date.now()): Reason {
  if (isBlocked(i)) return "blocked";
  if (isWarm(i, now)) return "warm";
  if (isYours(i)) return "reply";
  return "report";
}

export const REASON_LABEL: Record<Reason, string> = { blocked: "", warm: "warm", reply: "reply to you", report: "report" };

/** Highest score first; a stable sort, so equal scores keep the order they came in. */
export function byPriority<T extends AttentionItem>(items: readonly T[], now = Date.now()): T[] {
  return items.map((item, index) => ({ item, index, score: scoreOf(item, now) })).sort((a, b) => b.score - a.score || a.index - b.index).map((x) => x.item);
}
