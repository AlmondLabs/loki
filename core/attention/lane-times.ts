import type { Lane, LaneWindow } from "./lanes.ts";

interface Occurrence {
  order: number;
  lane: Lane;
  start: number;
  end: number;
  since: number;
}

const DAY_BACK_FOR_DUE = 1;
const DAYS_BACK_FOR_EDGES = 8;

const minutesOf = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

const localDay = (base: Date, offset: number) => new Date(base.getFullYear(), base.getMonth(), base.getDate() + offset);

const atMinutes = (day: Date, minutes: number) => new Date(day.getFullYear(), day.getMonth(), day.getDate(), 0, minutes).getTime();

function occurrences(lanes: Lane[], now: Date, back: number, ahead: number): Occurrence[] {
  const out: Occurrence[] = [];
  lanes.forEach((lane, order) => {
    for (const w of lane.times ?? []) {
      const startMin = minutesOf(w.start);
      const endMin = minutesOf(w.end);
      for (let offset = -back; offset <= ahead; offset++) {
        const day = localDay(now, offset);
        if (!w.days.includes(day.getDay())) continue;
        const start = atMinutes(day, startMin);
        const end = endMin > startMin ? atMinutes(day, endMin) : atMinutes(localDay(day, 1), endMin);
        out.push({ order, lane, start, end, since: Date.parse(w.since) });
      }
    }
  });
  return out;
}

function dueAt(occs: Occurrence[], t: number): Lane | null {
  let best: Occurrence | null = null;
  for (const o of occs) {
    if (o.start > t || o.end <= t) continue;
    if (!best || o.start > best.start || (o.start === best.start && (o.end < best.end || (o.end === best.end && o.order < best.order)))) best = o;
  }
  return best?.lane ?? null;
}

export function dueLane(lanes: Lane[], now: Date): Lane | null {
  return dueAt(occurrences(lanes, now, DAY_BACK_FOR_DUE, 0), now.getTime());
}

export function latestEdge(lanes: Lane[], now: Date): number | null {
  const t = now.getTime();
  let latest: number | null = null;
  for (const o of occurrences(lanes, now, DAYS_BACK_FOR_EDGES, 0)) {
    for (const edge of [o.start, o.end]) {
      if (edge <= t && edge >= o.since && (latest === null || edge > latest)) latest = edge;
    }
  }
  return latest;
}

export function nextChange(lanes: Lane[], now: Date): Date | null {
  const t = now.getTime();
  const occs = occurrences(lanes, now, DAY_BACK_FOR_DUE, 1);
  const current = dueAt(occs, t)?.id ?? "";
  const edges = [...new Set(occs.flatMap((o) => [o.start, o.end]).filter((e) => e > t))].sort((a, b) => a - b);
  const change = edges.find((e) => (dueAt(occs, e)?.id ?? "") !== current);
  return change === undefined ? null : new Date(change);
}

export function followLane(lanes: Lane[] | null, lastSwitch: number | null, held: boolean, now: Date): string | null {
  if (!lanes || held) return null;
  const edge = latestEdge(lanes, now);
  if (edge === null || (lastSwitch !== null && edge <= lastSwitch)) return null;
  return dueLane(lanes, now)?.id ?? "";
}

export function untilTime(lanes: Lane[], activeId: string, now: Date): Date | null {
  return dueLane(lanes, now)?.id === activeId ? nextChange(lanes, now) : null;
}

const CLOCK: Intl.DateTimeFormatOptions = { hour: "numeric", minute: "2-digit" };

export function clockText(at: Date, locale?: string): string {
  return new Intl.DateTimeFormat(locale, CLOCK).format(at);
}

const hhmmText = (hhmm: string, locale?: string) => clockText(new Date(2000, 0, 1, 0, minutesOf(hhmm)), locale);

const MONDAY_FIRST = [1, 2, 3, 4, 5, 6, 0];

const dateOfWeekday = (day: number) => new Date(2023, 0, 1 + day);

function daysText(days: number[], locale?: string): string {
  const set = new Set(days);
  if (set.size === 7) return "Every day";
  if (set.size === 5 && [1, 2, 3, 4, 5].every((d) => set.has(d))) return "Weekdays";
  if (set.size === 2 && set.has(0) && set.has(6)) return "Weekends";
  const name = new Intl.DateTimeFormat(locale, { weekday: "short" });
  return MONDAY_FIRST.filter((d) => set.has(d))
    .map((d) => name.format(dateOfWeekday(d)))
    .join(", ");
}

export function timesLabel(times: LaneWindow[], locale?: string): string {
  const groups = new Map<string, LaneWindow[]>();
  for (const w of times) {
    const key = MONDAY_FIRST.filter((d) => w.days.includes(d)).join(",");
    groups.set(key, [...(groups.get(key) ?? []), w]);
  }
  return [...groups.values()]
    .map((ws) => `${daysText(ws[0].days, locale)}, ${ws.map((w) => `${hhmmText(w.start, locale)}–${hhmmText(w.end, locale)}`).join(" and ")}`)
    .join("; ");
}
