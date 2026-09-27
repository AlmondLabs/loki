import type { AttentionItem } from "./model.ts";

/**
 * The inbox as a scheduler's ready queue: one number per card, one ordered list, no bands.
 *
 *   score = blocked ? 100 : 0          an approval or a question: an agent is stopped until you answer
 *         + new     ?  10 : 0          the agent said something since you last looked
 *         + 15 · focus                 the chat's share of what you have been engaging with lately (focus.ts)
 *         + blocked ? +0.1 · hours waiting     the agent that has waited longest comes first
 *                   : −0.1 · hours old         everything else drifts down, never up
 *
 * Every chat you have not archived is in the Inbox (queue.ts), so the score is what separates the ones with
 * something for you from the ones resting: a stopped agent dwarfs everything else, since that is the agent's
 * state, which nothing you did can tell; something new from the agent comes next. Then the
 * chats you are working in, learned from you: the task you are on rises while you work it, a task you have
 * moved on from gives way as soon as you engage elsewhere, and fades in a day or two with no park button.
 * Age settles ties and lets old cards drift down, except for a stopped agent, the one case where waiting makes
 * a card more urgent. A failed turn is not blocked: nothing waits on you, so it ranks by its chat's focus.
 * The score is stamped on every item once per rebuild (buildItems, on each event and the half-minute clock),
 * so the deck, the phone and the card's label all read the same instant. Deferred cards are the wait queue
 * (snooze.ts); they re-enter here when due or when their content changes, at their natural score.
 */
export const BLOCKED_POINTS = 100;
export const NEW_POINTS = 10;
export const FOCUS_POINTS = 15;
export const AGE_POINTS_PER_HOUR = 0.1;
export const WAITING_POINTS_PER_HOUR = 0.1;
/** A card whose focus is worth at least this many points says so ("in focus"). */
export const IN_FOCUS_POINTS = 3;

/** Who sent the last message into a conversation: a person, or Letta's scheduler firing a cron. */
export type AskedBy = "person" | "schedule";

/** The largest term of a card's score: the one word that explains its place in the list. */
export type Reason = "blocked" | "new" | "focus" | "other";
export const REASON_LABEL: Record<Reason, string> = { blocked: "", new: "", focus: "in focus", other: "" };

/** An item before its score and reason are stamped. */
export type Unscored = Omit<AttentionItem, "score" | "reason" | "focus">;

export const isBlocked = (i: Unscored): boolean => i.status === "approval" || i.status === "question";

export function scoreOf(i: Unscored, now = Date.now(), focus = 0): number {
  const hours = i.lastMessageAt ? Math.max(0, now - new Date(i.lastMessageAt).getTime()) / 3_600_000 : 0;
  const blocked = isBlocked(i);
  return (blocked ? BLOCKED_POINTS : 0) + (!blocked && i.unread ? NEW_POINTS : 0) + FOCUS_POINTS * focus + (blocked ? WAITING_POINTS_PER_HOUR : -AGE_POINTS_PER_HOUR) * hours;
}

export function reasonOf(i: Unscored, focus = 0): Reason {
  if (isBlocked(i)) return "blocked";
  if (i.unread && NEW_POINTS >= FOCUS_POINTS * focus) return "new";
  if (FOCUS_POINTS * focus >= IN_FOCUS_POINTS) return "focus";
  return "other";
}

/** Highest stamped score first; a stable sort, so equal scores keep the order they came in. */
export function byScore<T extends { score: number }>(items: readonly T[]): T[] {
  return items.map((item, index) => ({ item, index })).sort((a, b) => b.item.score - a.item.score || a.index - b.index).map((x) => x.item);
}

/** Stamp every item's score, reason and focus at one instant, then order them; `focus` is each chat's share by "agentId/conversationId". */
export function scored(items: readonly Unscored[], now = Date.now(), focus: Record<string, number> = {}): AttentionItem[] {
  return byScore(
    items.map((i) => {
      const f = focus[`${i.agentId}/${i.id}`] ?? 0;
      return { ...i, focus: f, score: scoreOf(i, now, f), reason: reasonOf(i, f) };
    }),
  );
}
