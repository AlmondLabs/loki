import type { AttentionItem } from "./model.ts";

export const BLOCKED_POINTS = 100;
export const NEW_POINTS = 10;
export const GOAL_POINTS = 8;
export const FOCUS_POINTS = 15;
export const AGE_POINTS_PER_HOUR = 0.1;
export const WAITING_POINTS_PER_HOUR = 0.1;
export const IN_FOCUS_POINTS = 3;

export type AskedBy = "person" | "schedule";

export type Reason = "blocked" | "new" | "focus" | "other";
export const REASON_LABEL: Record<Reason, string> = { blocked: "", new: "", focus: "in focus", other: "" };

export type Unscored = Omit<AttentionItem, "score" | "reason" | "focus">;

export const isBlocked = (i: Unscored): boolean => i.status === "approval" || i.status === "question";

export function scoreOf(i: Unscored, now = Date.now(), focus = 0): number {
  const hours = i.last_message_at ? Math.max(0, now - new Date(i.last_message_at).getTime()) / 3_600_000 : 0;
  const blocked = isBlocked(i);
  return (
    (blocked ? BLOCKED_POINTS : 0) +
    (!blocked && i.unread ? NEW_POINTS : 0) +
    (!blocked && i.unread && i.goal_title ? GOAL_POINTS : 0) +
    FOCUS_POINTS * focus +
    (blocked ? WAITING_POINTS_PER_HOUR : -AGE_POINTS_PER_HOUR) * hours
  );
}

export function reasonOf(i: Unscored, focus = 0): Reason {
  if (isBlocked(i)) return "blocked";
  if (i.unread && NEW_POINTS >= FOCUS_POINTS * focus) return "new";
  if (FOCUS_POINTS * focus >= IN_FOCUS_POINTS) return "focus";
  return "other";
}

export function byScore<T extends { score: number }>(items: readonly T[]): T[] {
  return items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => b.item.score - a.item.score || a.index - b.index)
    .map((x) => x.item);
}

export function scored(items: readonly Unscored[], now = Date.now(), focus: Record<string, number> = {}): AttentionItem[] {
  return byScore(
    items.map((i) => {
      const f = focus[`${i.agent_id}/${i.id}`] ?? 0;
      return { ...i, focus: f, score: scoreOf(i, now, f), reason: reasonOf(i, f) };
    }),
  );
}
