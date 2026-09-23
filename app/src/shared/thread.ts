import type { TranscriptRow } from "../../../core/attention/transcript.ts";

/**
 * A thread's reading marks, pure (test/deck.test.ts): where the red "New" line goes, and the day a
 * message belongs to in Slack's words. The phone's card and conversation and the desktop's Messages tab
 * draw them the same way.
 */

/**
 * Where "New" goes in an unread card's thread: after your last message, when the agent has written since.
 * Rows carry no times, so the boundary is the conversation's own turn-taking: what came after you last spoke.
 * Null when the card is read, the thread is not loaded, or the last word is yours.
 */
export function unreadBoundary(rows: TranscriptRow[] | undefined, unread: boolean): number | null {
  if (!unread || !rows?.length) return null;
  let at = 0;
  for (let i = rows.length - 1; i >= 0; i--)
    if (rows[i].role === "user") {
      at = i + 1;
      break;
    }
  return rows.slice(at).some((r) => r.role === "assistant") ? at : null;
}

const DAY_MS = 86_400_000;
const startOfDay = (t: number) => {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};

/** A message day the way Slack writes it: Today, Yesterday, the weekday within the week, then the date (with the year when it is not this one). */
export function dayLabel(iso: string | null | undefined, now: number = Date.now()): string | null {
  const t = iso ? Date.parse(iso) : Number.NaN;
  if (!Number.isFinite(t)) return null;
  const days = Math.round((startOfDay(now) - startOfDay(t)) / DAY_MS);
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  const d = new Date(t);
  if (days < 7) return d.toLocaleDateString("en-GB", { weekday: "long" });
  const sameYear = d.getFullYear() === new Date(now).getFullYear();
  return d.toLocaleDateString("en-GB", sameYear ? { weekday: "short", day: "numeric", month: "short" } : { day: "numeric", month: "short", year: "numeric" });
}
