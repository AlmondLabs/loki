/**
 * How the past arrives in batches (plan 067, R8, KTD13). The first sync brings every unread direct item of the last 3
 * days. After that, each time the account has no open outside cards (resting cards are open: Next sets a card aside,
 * it does not clear it), the next older batch of at most 20 threads comes, stepping back through windows 7, 14 and 30
 * days before the first sync, then 30 days more each time, until nothing older is left. The cursor lives on the
 * account (Accounts.setBackfill), so a restart goes on where it stood.
 */

/** Where an account's batches stand. */
export interface RefillCursor {
  /** ISO time of the first sync: every window is measured back from it, so the steps stay put as time passes. */
  anchor: string;
  /** ISO time: every unread item newer than this has been read; the next batch reads older ones. */
  before: string;
  /** How many days before the anchor the finished windows reach: 0 before the first sync, then 3, 7, 14, 30, 60… */
  days: number;
  /** Nothing older is left to bring. */
  exhausted: boolean;
}

/** One window to read: unread items at or after `after` and before `before`, up to `limit` new threads (null: all). */
export interface RefillWindow {
  after: string;
  before: string;
  limit: number | null;
}

/**
 * How reading a window went: `full` stopped at its limit, at the oldest thread it took; `done` read the whole window;
 * `empty` found no unread mail in it at all, and says when the newest unread item older than the window came (null
 * when there is none, and the past is all in).
 */
export type RefillResult = { kind: "full"; oldest_at: string } | { kind: "done" } | { kind: "empty"; newest_older_at: string | null };

/** The most threads one later batch brings. */
export const REFILL_BATCH = 20;
/** The windows' reach before the anchor, in days; past the last, each window reaches STEP_DAYS further. */
const WINDOW_DAYS = [3, 7, 14, 30];
const STEP_DAYS = 30;
const DAY = 24 * 3600 * 1000;

/** The reach of the window after one reaching `days` back. */
const nextDays = (days: number): number => WINDOW_DAYS.find((d) => d > days) ?? days + STEP_DAYS;
const back = (anchor: string, days: number): string => new Date(Date.parse(anchor) - days * DAY).toISOString();

/** A new account's cursor, at its first sync: nothing read yet. */
export function firstRefill(now: Date): RefillCursor {
  const at = now.toISOString();
  return { anchor: at, before: at, days: 0, exhausted: false };
}

/**
 * The window to read next, or null when none is due: the past is all in, or the account still has `open` outside
 * cards. The first window (the last 3 days) is read whole whatever the count, since it is the connection itself.
 */
export function refillWindow(cursor: RefillCursor, open: number): RefillWindow | null {
  if (cursor.exhausted || (cursor.days > 0 && open > 0)) return null;
  return { after: back(cursor.anchor, nextDays(cursor.days)), before: cursor.before, limit: cursor.days === 0 ? null : REFILL_BATCH };
}

/** The cursor after reading the window `span`. */
export function advanceRefill(cursor: RefillCursor, span: RefillWindow, result: RefillResult): RefillCursor {
  if (result.kind === "full") return { ...cursor, before: result.oldest_at };
  if (result.kind === "done") return { ...cursor, before: span.after, days: nextDays(cursor.days) };
  if (result.newest_older_at === null) return { ...cursor, before: span.after, days: nextDays(cursor.days), exhausted: true };
  // Skip the empty windows: go on from the one that holds the newest older item, just after that item.
  const at = Date.parse(result.newest_older_at);
  let days = nextDays(cursor.days);
  while (Date.parse(back(cursor.anchor, nextDays(days))) > at) days = nextDays(days);
  return { ...cursor, before: new Date(Math.min(at + 1000, Date.parse(back(cursor.anchor, days)))).toISOString(), days };
}

/** A cursor as the account keeps it, or null when it holds none yet (or something that is not one). */
export function parseRefill(v: unknown): RefillCursor | null {
  if (typeof v !== "object" || v === null) return null;
  const r = v as Record<string, unknown>;
  if (typeof r.anchor !== "string" || typeof r.before !== "string" || typeof r.days !== "number" || typeof r.exhausted !== "boolean") return null;
  if (Number.isNaN(Date.parse(r.anchor)) || Number.isNaN(Date.parse(r.before))) return null;
  return { anchor: r.anchor, before: r.before, days: r.days, exhausted: r.exhausted };
}
