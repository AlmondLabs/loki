/**
 * Product analytics for loki in PostHog's shape, without PostHog: one event per line in
 * ~/.letta/loki/logs/events.jsonl — `{ event, timestamp, distinct_id, properties }`. Local only: the mod writes
 * it, nothing reads it but `bun run analytics` on this machine, and it would import into PostHog's batch
 * endpoint as is should that ever be wanted. Properties are ids and counts (a desk's scope, a model's handle),
 * never message text, titles or paths. This module is the shape and the arithmetic; mod/analytics.ts captures,
 * mod/bridge.ts and the app decide when, scripts/analytics.ts turns the file into a report.
 */

/** Where it happened: the Mac window, a paired phone, or the mod itself (turns and tools, whichever client began them). */
export type DeviceType = "mac" | "phone" | "mod";
export const DEVICE_TYPES: readonly DeviceType[] = ["mac", "phone", "mod"];

export interface EventProperties {
  $device_type: DeviceType;
  /** Events on one device within SESSION_GAP_MS of each other share a session; the mod cuts them. */
  $session_id?: string;
  /** The view on screen when a client sent the event: the Mac's segment, the phone's tab or page. */
  $screen?: string;
  $app_version?: string | null;
  $lib: "loki";
  [property: string]: unknown;
}

export interface AnalyticsEvent {
  event: string;
  /** ISO time. */
  timestamp: string;
  /** One random id per install (state/analytics.json): the same person across lines, without saying who. */
  distinct_id: string;
  properties: EventProperties;
}

export const SESSION_GAP_MS = 30 * 60 * 1000;
/** Event names are snake_case words, object then verb: view_opened, message_sent. Anything else from a client is refused. */
export const EVENT_NAME_RE = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/;
export const EVENT_NAME_MAX = 48;

/** Every event captured, with the properties it carries. The report lists the ones that never fired in the period. */
export const EVENTS: Record<string, string> = {
  view_opened: "a view came on screen { view, from } — the Mac's segments, the phone's tabs and pages",
  desk_switched: "the desk on screen changed { desk }",
  chat_opened: "the desk chat opened",
  chat_closed: "the desk chat closed",
  message_sent: "a message went out { origin: desk | inbox | lesson, images, queued }",
  approval_decided: "a tool permission decided { behavior }",
  question_answered: "an agent's question answered",
  command_run: "a harness slash command run { command }",
  model_switched: "a conversation's model switched { model, effort }",
  mode_set: "a conversation's permission mode set { mode }",
  inbox_pass_completed: "the inbox deck closed { decided, next, later, approve, deny, replies }",
  conversation_marked_seen: "a conversation marked seen",
  conversation_kept_unread: "a conversation kept unread",
  card_deferred: "a card put off with later { skips }",
  deferral_cleared: "a deferral cleared",
  desk_pinned: "a desk pinned or unpinned { pinned }",
  widget_gestured: "a widget moved, resized, opened, closed or set { kind }",
  desk_arranged: "a desk tidied",
  widget_trashed: "a widget deleted",
  turn_started: "an agent turn began, typed anywhere (the terminal included) { desk }",
  tool_used: "the agent called a desk tool { tool }",
};

/** For each event, the property the report breaks it down by. */
export const BREAKDOWN: Record<string, string> = {
  view_opened: "view",
  desk_switched: "desk",
  turn_started: "desk",
  message_sent: "origin",
  model_switched: "model",
  mode_set: "mode",
  command_run: "command",
  tool_used: "tool",
  widget_gestured: "kind",
  approval_decided: "behavior",
  card_deferred: "skips",
};

export function isDeviceType(value: unknown): value is DeviceType {
  return typeof value === "string" && (DEVICE_TYPES as readonly string[]).includes(value);
}

export function isEventName(value: unknown): value is string {
  return typeof value === "string" && value.length <= EVENT_NAME_MAX && EVENT_NAME_RE.test(value);
}

export function makeEvent(event: string, distinctId: string, properties: EventProperties, now: Date = new Date()): AnalyticsEvent {
  return { event, timestamp: now.toISOString(), distinct_id: distinctId, properties };
}

/** Parse the file's text; a line that is not an event (cut short, hand-edited) is skipped, not fatal. */
export function parseEvents(text: string): AnalyticsEvent[] {
  const out: AnalyticsEvent[] = [];
  for (const raw of text.split("\n")) {
    if (!raw.trim()) continue;
    try {
      const v = JSON.parse(raw) as Record<string, unknown>;
      const p = v.properties as Record<string, unknown> | undefined;
      if (!isEventName(v.event) || typeof v.timestamp !== "string" || Number.isNaN(Date.parse(v.timestamp)) || typeof v.distinct_id !== "string") continue;
      if (!p || typeof p !== "object" || !isDeviceType(p.$device_type)) continue;
      out.push({ event: v.event, timestamp: v.timestamp, distinct_id: v.distinct_id, properties: { ...p, $device_type: p.$device_type, $lib: "loki" } });
    } catch {
      // not ours
    }
  }
  return out;
}

export interface EventRow {
  event: string;
  count: number;
  /** Distinct sessions the event fired in. */
  sessions: number;
  mac: number;
  phone: number;
  mod: number;
}

export interface AnalyticsReport {
  window: { from: string | null; to: string | null; days: number; events: number; activeDays: number };
  sessions: { count: number; byDevice: Record<DeviceType, number>; medianMinutes: number | null; perActiveDay: number | null };
  /** Every event that fired, most often first. */
  events: EventRow[];
  /** The BREAKDOWN property's values for each event that fired, top eight. */
  breakdowns: Array<{ event: string; property: string; values: Array<[string, number]> }>;
  inbox: { passes: number; decided: number; perPass: number | null; next: number; later: number; approve: number; deny: number; replies: number };
  /** Events by local hour of day (24) and weekday (7, Sunday first). */
  hours: number[];
  weekdays: number[];
  neverFired: string[];
}

const DAY_MS = 86_400_000;
const tally = (m: Map<string, number>, key: string, n = 1) => m.set(key, (m.get(key) ?? 0) + n);
const ranked = (m: Map<string, number>, limit = Infinity): Array<[string, number]> => [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, limit);
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
function median(values: number[]): number | null {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** Everything in the last `days` days up to `now`, counted the way product analytics counts. */
export function analyticsReport(all: AnalyticsEvent[], { now, days }: { now: number; days: number }): AnalyticsReport {
  const since = now - days * DAY_MS;
  const events = all.filter((e) => {
    const t = Date.parse(e.timestamp);
    return t >= since && t <= now;
  });
  const rows = new Map<string, EventRow>();
  const eventSessions = new Map<string, Set<string>>();
  const sessionSpan = new Map<string, { device: DeviceType; first: number; last: number }>();
  const breakdown = new Map<string, Map<string, number>>();
  const activeDays = new Set<string>();
  const hours = new Array<number>(24).fill(0);
  const weekdays = new Array<number>(7).fill(0);
  const inbox = { passes: 0, decided: 0, perPass: null as number | null, next: 0, later: 0, approve: 0, deny: 0, replies: 0 };
  const perPass: number[] = [];

  for (const e of events) {
    const p = e.properties;
    const t = Date.parse(e.timestamp);
    const when = new Date(t);
    const row = rows.get(e.event) ?? { event: e.event, count: 0, sessions: 0, mac: 0, phone: 0, mod: 0 };
    row.count++;
    row[p.$device_type]++;
    rows.set(e.event, row);
    if (typeof p.$session_id === "string") {
      (eventSessions.get(e.event) ?? eventSessions.set(e.event, new Set()).get(e.event)!).add(p.$session_id);
      const span = sessionSpan.get(p.$session_id);
      if (span) {
        span.first = Math.min(span.first, t);
        span.last = Math.max(span.last, t);
      } else sessionSpan.set(p.$session_id, { device: p.$device_type, first: t, last: t });
    }
    const by = BREAKDOWN[e.event];
    if (by && p[by] !== undefined && p[by] !== null) tally(breakdown.get(e.event) ?? breakdown.set(e.event, new Map()).get(e.event)!, String(p[by]));
    activeDays.add(`${when.getFullYear()}-${when.getMonth()}-${when.getDate()}`);
    hours[when.getHours()]++;
    weekdays[when.getDay()]++;
    if (e.event === "inbox_pass_completed") {
      inbox.passes++;
      inbox.decided += num(p.decided);
      perPass.push(num(p.decided));
      inbox.next += num(p.next);
      inbox.later += num(p.later);
      inbox.approve += num(p.approve);
      inbox.deny += num(p.deny);
      inbox.replies += num(p.replies);
    }
  }
  inbox.perPass = median(perPass);
  for (const row of rows.values()) row.sessions = eventSessions.get(row.event)?.size ?? 0;
  const byDevice: Record<DeviceType, number> = { mac: 0, phone: 0, mod: 0 };
  for (const s of sessionSpan.values()) byDevice[s.device]++;
  const stamps = events.map((e) => Date.parse(e.timestamp));
  return {
    window: { from: stamps.length ? new Date(Math.min(...stamps)).toISOString() : null, to: stamps.length ? new Date(Math.max(...stamps)).toISOString() : null, days, events: events.length, activeDays: activeDays.size },
    sessions: {
      count: sessionSpan.size,
      byDevice,
      medianMinutes: median([...sessionSpan.values()].map((s) => (s.last - s.first) / 60_000)),
      perActiveDay: activeDays.size ? Math.round((sessionSpan.size / activeDays.size) * 10) / 10 : null,
    },
    events: [...rows.values()].sort((a, b) => b.count - a.count || a.event.localeCompare(b.event)),
    breakdowns: [...breakdown.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([event, values]) => ({ event, property: BREAKDOWN[event], values: ranked(values, 8) })),
    inbox,
    hours,
    weekdays,
    neverFired: Object.keys(EVENTS).filter((name) => !rows.has(name)),
  };
}

const WEEKDAY = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const pct = (n: number, of: number) => (of ? `${Math.round((n / of) * 100)}%` : "–");
const cell = (n: number, width = 6) => (n ? String(n) : "–").padStart(width);
/** A histogram as one line: each bucket's share as a bar glyph, so the shape reads at a glance. */
function bars(values: number[], labels: (i: number) => string): string {
  const max = Math.max(1, ...values);
  const glyphs = " ▁▂▃▄▅▆▇█";
  return values.map((v, i) => `${labels(i)}${glyphs[Math.round((v / max) * (glyphs.length - 1))]}`).join(" ");
}

/** The report as text, for the terminal. */
export function formatAnalyticsReport(r: AnalyticsReport): string {
  const w = r.window;
  const out: string[] = [];
  out.push(`analytics · last ${w.days} days${w.from ? ` · ${w.from.slice(0, 10)} → ${w.to!.slice(0, 10)}` : ""} · ${w.events} events on ${w.activeDays} active day${w.activeDays === 1 ? "" : "s"}`);
  if (!w.events) return out.join("\n");
  const s = r.sessions;
  out.push(`  sessions ${s.count} (mac ${s.byDevice.mac} · phone ${s.byDevice.phone} · mod ${s.byDevice.mod}) · median ${s.medianMinutes === null ? "–" : `${Math.round(s.medianMinutes)} min`} · ${s.perActiveDay ?? "–"} an active day`);
  const width = Math.max(12, ...r.events.map((e) => e.event.length));
  out.push("", `${"event".padEnd(width + 2)} ${"count".padStart(6)} ${"sessions".padStart(8)} ${"mac".padStart(6)} ${"phone".padStart(6)} ${"mod".padStart(6)}`);
  for (const e of r.events) out.push(`  ${e.event.padEnd(width)} ${cell(e.count)} ${cell(e.sessions, 8)} ${cell(e.mac)} ${cell(e.phone)} ${cell(e.mod)}`);
  if (r.breakdowns.length) {
    out.push("", "breakdowns");
    const bw = Math.max(...r.breakdowns.map((b) => b.event.length + b.property.length + 3));
    for (const b of r.breakdowns) out.push(`  ${`${b.event} · ${b.property}`.padEnd(bw)}  ${b.values.map(([v, n]) => `${v} ${n}`).join(" · ")}`);
  }
  const i = r.inbox;
  if (i.passes) out.push("", `inbox passes ${i.passes} · ${i.decided} cards · median ${i.perPass} a pass · next ${pct(i.next, i.decided)} · later ${pct(i.later, i.decided)} · approve ${pct(i.approve, i.decided)} · deny ${pct(i.deny, i.decided)} · ${i.replies} replies`);
  out.push("", "when", `  hour  ${bars(r.hours, (h) => (h % 6 === 0 ? String(h).padStart(2, "0") : ""))}`, `  day   ${bars(r.weekdays, (d) => WEEKDAY[d])}`);
  out.push("", `never fired: ${r.neverFired.length ? r.neverFired.join(", ") : "nothing — every event fired at least once"}`);
  return out.join("\n");
}
