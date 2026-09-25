import type { TranscriptRow } from "../../../core/attention/transcript.ts";

/**
 * A thread's reading marks, pure (test/deck.test.ts): where the red "New" line goes, and the day a
 * message belongs to in Slack's words. The phone's card and conversation and the desktop's Messages tab
 * draw them the same way.
 */

/**
 * Where "New" goes in an unread card's thread. With `seenAt` and times on the rows: before the first
 * assistant message after the last row you are known to have read. Rows without times prove nothing, so
 * when times cannot place it, or place nothing though the card is unread, the rule is the conversation's own
 * turn-taking: what came after you last spoke.
 * A look (`viewedAt`, the mod's viewed marker) newer than done moves it: before what came since that look,
 * and no line when nothing did, though the card stays unread. An open view passes the look it held at open
 * (holdMark), not the one its own open just stamped.
 * Null when the card is read, the thread is not loaded, or the last word is yours.
 */
export function unreadBoundary(rows: TranscriptRow[] | undefined, unread: boolean, seenAt?: string | null, viewedAt?: string | null): number | null {
  if (!unread || !rows?.length) return null;
  const looked = viewedAt ? Date.parse(viewedAt) : Number.NaN;
  if (Number.isFinite(looked) && !(looked <= (seenAt ? Date.parse(seenAt) : Number.NaN))) {
    const byLook = timedBoundary(rows, looked);
    if (byLook !== undefined) return byLook;
  }
  const byTime = seenAt ? timedBoundary(rows, Date.parse(seenAt)) : undefined;
  // Times that find nothing new on an unread card (seenAt stamped mid-stream, say) are wrong about it: the turn rule decides.
  if (byTime != null) return byTime;
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

/** The look an open conversation keeps for its New line: the one from before this open, while it stays open. */
export interface HeldMark {
  /** The open conversation ("<agentId>/<conversationId>"). */
  key: string;
  mark: string | null;
}

/**
 * Slack's New line holds while you read: taken once the open conversation's item is known (before this open's own
 * look lands), kept while `key` stays the same (the item blinking out on a reload included), dropped when
 * nothing is open (`key` null) or another conversation opens.
 */
export function holdMark(prev: HeldMark | null, key: string | null, item: { viewedAt: string | null } | null | undefined): HeldMark | null {
  if (!key) return null;
  if (prev?.key === key) return prev;
  return item ? { key, mark: item.viewedAt ?? null } : null;
}

const DAY_MS = 86_400_000;

// The formats the thread writes, and one Intl.DateTimeFormat per locale and format, built on first use: every
// message's time went through toLocaleTimeString, which builds a formatter per call (20 ms on a long thread).
const CLOCK: Intl.DateTimeFormatOptions = { hour: "numeric", minute: "2-digit" };
const WEEKDAY: Intl.DateTimeFormatOptions = { weekday: "long" };
const SHORT_DATE: Intl.DateTimeFormatOptions = { weekday: "short", day: "numeric", month: "short" };
const LONG_DATE: Intl.DateTimeFormatOptions = { day: "numeric", month: "short", year: "numeric" };
const formatters = new Map<Intl.DateTimeFormatOptions, Map<string, Intl.DateTimeFormat>>();
let built = 0;

/**
 * A local date and time in `locale`, through the cached formatter. The formatter works in UTC on the local
 * clock's reading (the day and hour as the user's zone has them), so it never holds a time zone of its own
 * and stays right when the zone changes under it.
 */
function format(locale: string | undefined, options: Intl.DateTimeFormatOptions, d: Date): string {
  let byLocale = formatters.get(options);
  if (!byLocale) formatters.set(options, (byLocale = new Map()));
  let f = byLocale.get(locale ?? "");
  if (!f) {
    f = new Intl.DateTimeFormat(locale, { ...options, timeZone: "UTC" });
    byLocale.set(locale ?? "", f);
    built++;
  }
  return f.format(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds()));
}

/** How many formatters have been built (a test's handle on "once per format"). */
export const formattersBuilt = () => built;

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
  if (days < 7) return format("en-GB", WEEKDAY, d);
  const sameYear = d.getFullYear() === new Date(now).getFullYear();
  return format("en-GB", sameYear ? SHORT_DATE : LONG_DATE, d);
}

/** A calendar day in the user's time zone, as a comparable key. */
const dayKey = (t: number) => {
  const d = new Date(t);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
};

/**
 * The day pill before each row, Slack's: a label on the first timed row of each calendar day (the user's
 * time zone), null everywhere else. A row without a time starts no day. Anything timed works (the Transcript
 * passes its messages and widget rows together).
 */
export function dayPills(rows: ReadonlyArray<{ at?: string }>, now: number = Date.now()): Array<string | null> {
  let last: string | null = null;
  return rows.map((r) => {
    const key = dayOf(r);
    if (key === null || key === last) return null;
    last = key;
    return dayLabel(r.at, now);
  });
}

/**
 * Each row's calendar day. The parsed time is kept per row (a settled row is the same object from update to
 * update); the day is read from it each time, in the zone the user is in now.
 */
const times = new WeakMap<object, { at: string | undefined; t: number }>();
function dayOf(r: { at?: string }): string | null {
  let hit = times.get(r);
  if (!hit || hit.at !== r.at) times.set(r, (hit = { at: r.at, t: r.at ? Date.parse(r.at) : Number.NaN }));
  return Number.isFinite(hit.t) ? dayKey(hit.t) : null;
}

/** A message's time the way the user's locale writes a clock ("10:42 AM", "10:42"); null without one. */
export function clockLabel(iso: string | null | undefined): string | null {
  const t = iso ? Date.parse(iso) : Number.NaN;
  if (!Number.isFinite(t)) return null;
  return format(undefined, CLOCK, new Date(t));
}
