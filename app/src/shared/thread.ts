import type { TranscriptRow } from "../../../core/attention/transcript.ts";

/**
 * A thread's reading marks, pure (test/deck.test.ts): where the red "New" line goes, and the day a
 * message belongs to in Slack's words. The phone's card and conversation and the desktop's Messages tab
 * draw them the same way.
 */

/**
 * Where "New" goes in an unread card's thread. With `seenAt` and times on the rows: before the first
 * assistant message after the last row you are known to have read. Rows without times prove nothing, so
 * when times cannot place it the rule is the conversation's own turn-taking: what came after you last spoke.
 * Null when the card is read, the thread is not loaded, or the last word is yours.
 */
export function unreadBoundary(rows: TranscriptRow[] | undefined, unread: boolean, seenAt?: string | null): number | null {
  if (!unread || !rows?.length) return null;
  const byTime = seenAt ? timedBoundary(rows, Date.parse(seenAt)) : undefined;
  if (byTime !== undefined) return byTime;
  let at = 0;
  for (let i = rows.length - 1; i >= 0; i--)
    if (rows[i].role === "user") {
      at = i + 1;
      break;
    }
  return rows.slice(at).some((r) => r.role === "assistant") ? at : null;
}

/** The time rule, or undefined when the times cannot place the line (none read, or untimed rows before the first time). */
function timedBoundary(rows: TranscriptRow[], seen: number): number | null | undefined {
  if (!Number.isFinite(seen)) return undefined;
  let from = -1;
  rows.forEach((r, i) => {
    const t = r.at ? Date.parse(r.at) : Number.NaN;
    if (t <= seen) from = i + 1;
  });
  if (from < 0) {
    // Nothing is known read: only a thread timed from its first row can say that all of it is new.
    if (!rows[0].at) return undefined;
    from = 0;
  }
  for (let i = from; i < rows.length; i++) if (rows[i].role === "assistant") return i;
  return null;
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

/** A calendar day in the user's time zone, as a comparable key. */
const dayKey = (t: number) => {
  const d = new Date(t);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
};

/**
 * The day pill before each row, Slack's: a label on the first timed row of each calendar day (the user's
 * time zone), null everywhere else. A row without a time starts no day.
 */
export function dayPills(rows: TranscriptRow[], now: number = Date.now()): Array<string | null> {
  let last: string | null = null;
  return rows.map((r) => {
    const t = r.at ? Date.parse(r.at) : Number.NaN;
    if (!Number.isFinite(t)) return null;
    const key = dayKey(t);
    if (key === last) return null;
    last = key;
    return dayLabel(r.at, now);
  });
}

/** A message's time the way the user's locale writes a clock ("10:42 AM", "10:42"); null without one. */
export function clockLabel(iso: string | null | undefined): string | null {
  const t = iso ? Date.parse(iso) : Number.NaN;
  if (!Number.isFinite(t)) return null;
  return new Date(t).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}
