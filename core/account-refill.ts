export interface RefillCursor {
  anchor: string;
  before: string;
  days: number;
  exhausted: boolean;
}

export interface RefillWindow {
  after: string;
  before: string;
  limit: number | null;
}

export type RefillResult = { kind: "full"; oldest_at: string } | { kind: "done" } | { kind: "empty"; newest_older_at: string | null };

export const PAST_CAP = 20;
const WINDOW_DAYS = [3, 7, 14, 30];
const STEP_DAYS = 30;
const DAY = 24 * 3600 * 1000;

const nextDays = (days: number): number => WINDOW_DAYS.find((d) => d > days) ?? days + STEP_DAYS;
const back = (anchor: string, days: number): string => new Date(Date.parse(anchor) - days * DAY).toISOString();

export function firstRefill(now: Date): RefillCursor {
  const at = now.toISOString();
  return { anchor: at, before: at, days: 0, exhausted: false };
}

export function refillWindow(cursor: RefillCursor, open: number): RefillWindow | null {
  if (cursor.exhausted || (cursor.days > 0 && open >= PAST_CAP)) return null;
  return { after: back(cursor.anchor, nextDays(cursor.days)), before: cursor.before, limit: cursor.days === 0 ? null : PAST_CAP - open };
}

export function advanceRefill(cursor: RefillCursor, span: RefillWindow, result: RefillResult): RefillCursor {
  if (result.kind === "full") return { ...cursor, before: result.oldest_at };
  if (result.kind === "done") return { ...cursor, before: span.after, days: nextDays(cursor.days) };
  if (result.newest_older_at === null) return { ...cursor, before: span.after, days: nextDays(cursor.days), exhausted: true };
  const at = Date.parse(result.newest_older_at);
  let days = nextDays(cursor.days);
  while (Date.parse(back(cursor.anchor, nextDays(days))) > at) days = nextDays(days);
  return { ...cursor, before: new Date(Math.min(at + 1000, Date.parse(back(cursor.anchor, days)))).toISOString(), days };
}

export function parseRefill(v: unknown): RefillCursor | null {
  if (typeof v !== "object" || v === null) return null;
  const r = v as Record<string, unknown>;
  if (typeof r.anchor !== "string" || typeof r.before !== "string" || typeof r.days !== "number" || typeof r.exhausted !== "boolean") return null;
  if (Number.isNaN(Date.parse(r.anchor)) || Number.isNaN(Date.parse(r.before))) return null;
  return { anchor: r.anchor, before: r.before, days: r.days, exhausted: r.exhausted };
}
