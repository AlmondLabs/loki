import type { TranscriptRow } from "../../../core/attention/transcript.ts";

export function unreadBoundary(rows: TranscriptRow[] | undefined, unread: boolean, seenAt?: string | null, viewedAt?: string | null): number | null {
  if (!unread || !rows?.length) return null;
  const looked = viewedAt ? Date.parse(viewedAt) : Number.NaN;
  if (Number.isFinite(looked) && !(looked <= (seenAt ? Date.parse(seenAt) : Number.NaN))) {
    const byLook = timedBoundary(rows, looked);
    if (byLook !== undefined) return byLook;
  }
  const byTime = seenAt ? timedBoundary(rows, Date.parse(seenAt)) : undefined;
  if (byTime != null) return byTime;
  let at = 0;
  for (let i = rows.length - 1; i >= 0; i--)
    if (rows[i].role === "user") {
      at = i + 1;
      break;
    }
  return rows.slice(at).some((r) => r.role === "assistant") ? at : null;
}

function timedBoundary(rows: TranscriptRow[], seen: number): number | null | undefined {
  if (!Number.isFinite(seen)) return undefined;
  let from = -1;
  rows.forEach((r, i) => {
    const t = r.at ? Date.parse(r.at) : Number.NaN;
    if (t <= seen) from = i + 1;
  });
  if (from < 0) {
    if (!rows[0].at) return undefined;
    from = 0;
  }
  for (let i = from; i < rows.length; i++) if (rows[i].role === "assistant") return i;
  return null;
}

export interface HeldMark {
  key: string;
  mark: string | null;
}

export function holdMark(prev: HeldMark | null, key: string | null, item: { viewedAt: string | null } | null | undefined): HeldMark | null {
  if (!key) return null;
  if (prev?.key === key) return prev;
  return item ? { key, mark: item.viewedAt ?? null } : null;
}

const DAY_MS = 86_400_000;

const CLOCK: Intl.DateTimeFormatOptions = { hour: "numeric", minute: "2-digit" };
const WEEKDAY: Intl.DateTimeFormatOptions = { weekday: "long" };
const SHORT_DATE: Intl.DateTimeFormatOptions = { weekday: "short", day: "numeric", month: "short" };
const LONG_DATE: Intl.DateTimeFormatOptions = { day: "numeric", month: "short", year: "numeric" };
const formatters = new Map<Intl.DateTimeFormatOptions, Map<string, Intl.DateTimeFormat>>();
let built = 0;

function formatCached(locale: string | undefined, options: Intl.DateTimeFormatOptions, d: Date): string {
  let byLocale = formatters.get(options);
  if (!byLocale) formatters.set(options, (byLocale = new Map<string, Intl.DateTimeFormat>()));
  let f = byLocale.get(locale ?? "");
  if (!f) {
    f = new Intl.DateTimeFormat(locale, { ...options, timeZone: "UTC" });
    byLocale.set(locale ?? "", f);
    built++;
  }
  return f.format(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds()));
}

export const formattersBuilt = () => built;

const startOfDay = (t: number) => {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};

export function dayLabel(iso: string | null | undefined, now: number = Date.now()): string | null {
  const t = iso ? Date.parse(iso) : Number.NaN;
  if (!Number.isFinite(t)) return null;
  const days = Math.round((startOfDay(now) - startOfDay(t)) / DAY_MS);
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  const d = new Date(t);
  if (days < 7) return formatCached("en-GB", WEEKDAY, d);
  const sameYear = d.getFullYear() === new Date(now).getFullYear();
  return formatCached("en-GB", sameYear ? SHORT_DATE : LONG_DATE, d);
}

const dayKey = (t: number) => {
  const d = new Date(t);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
};

export function dayPills(rows: ReadonlyArray<{ at?: string }>, now: number = Date.now()): Array<string | null> {
  let last: string | null = null;
  return rows.map((r) => {
    const key = dayOf(r);
    if (key === null || key === last) return null;
    last = key;
    return dayLabel(r.at, now);
  });
}

const times = new WeakMap<object, { at: string | undefined; t: number }>();
function dayOf(r: { at?: string }): string | null {
  let hit = times.get(r);
  if (!hit || hit.at !== r.at) times.set(r, (hit = { at: r.at, t: r.at ? Date.parse(r.at) : Number.NaN }));
  return Number.isFinite(hit.t) ? dayKey(hit.t) : null;
}

export function clockLabel(iso: string | null | undefined): string | null {
  const t = iso ? Date.parse(iso) : Number.NaN;
  if (!Number.isFinite(t)) return null;
  return formatCached(undefined, CLOCK, new Date(t));
}
