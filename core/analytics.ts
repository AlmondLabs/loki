/**
 * Product analytics for loki in PostHog's shape, without PostHog: one event per line in
 * ~/.loki/logs/events.jsonl — `{ event, timestamp, distinct_id, properties }`. Local only: the mod writes
 * it, nothing reads it but `bun run analytics` on this machine, and it would import into PostHog's batch
 * endpoint as is should that ever be wanted. Properties are ids and counts (a desk's scope, a model's handle),
 * never message text, titles or paths. This module is the shape and the arithmetic; mod/analytics.ts captures,
 * mod/bridge.ts and the app decide when, daemon/telemetry.ts measures each agent turn, scripts/analytics.ts turns
 * the file into a report. A turn's `turn_id` (the daemon's) joins the client events made while it ran or after it.
 */

/** Where it happened: the desktop window (on a Mac, Windows or Linux), a paired phone, or the mod itself (turns and tools, whichever client began them). */
export type DeviceType = "mac" | "windows" | "linux" | "phone" | "mod";
export const DEVICE_TYPES: readonly DeviceType[] = ["mac", "windows", "linux", "phone", "mod"];

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
  desk_switched: "the chat on screen changed { desk }",
  chat_opened: "the desk chat opened",
  chat_closed: "the desk chat closed",
  message_sent: "a message went out { desk, agent, turn_id (the turn running when queued, else the last one), origin: desk | inbox | lesson, images, files, queued }",
  approval_requested: "an agent asked for a tool permission or asked a question { desk, agent, tool, kind: approval | question }",
  approval_decided: "a tool permission decided { desk, agent, turn_id, behavior, wait_ms }",
  question_answered: "an agent's question answered { desk, agent, wait_ms }",
  command_run: "a harness slash command run { command }",
  model_switched: "a conversation's model switched { model, effort }",
  mode_set: "a conversation's permission mode set { mode }",
  folder_changed: "a conversation moved to another folder { desk, agent }",
  inbox_pass_completed: "the inbox deck closed { decided, next, archive, approve, deny, replies, shown, duration_ms }",
  inbox_card_shown: "a card came to the top of the inbox { desk, agent, rank, of, score, focus, reason, status, new, idle_min }",
  inbox_card_decided: "an inbox card decided { action: next | archive | approve | deny | reply | answer | open, via: key | click | swipe | tap, desk, agent, turn_id (the chat's running or last turn), rank, of, score, focus, reason, status, new, idle_min, dwell_ms (only while loki was visible and focused) }",
  inbox_card_undone: "an inbox Next or Archive taken back { action: next | archive, desk, agent }",
  inbox_filtered: "an agent pill chosen in the inbox { agent } (null: All)",
  chat_archived: "a chat archived { desk, turn_id (its last turn), origin: inbox | sidebar | chat_header | phone_list | phone_chat }",
  chat_restored: "a chat restored from the archive { desk, origin: inbox_undo | sidebar | chat_header | phone_list | phone_chat }",
  conversation_marked_seen: "a conversation marked seen",
  conversation_kept_unread: "a conversation kept unread",
  desk_pinned: "a desk pinned or unpinned { pinned }",
  widget_gestured: "a widget moved, resized, opened, closed or set { kind }",
  desk_arranged: "a desk tidied",
  widget_trashed: "a widget deleted",
  turn_finished:
    "an agent turn ended, measured by the daemon from its store { desk, chat, agent, model, harness_version, turn_id, origin: message | schedule | background | subagent | recall | reflection, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens, cache_share, cost, responses, ttft_ms, total_ms, model_ms, tool_ms, overhead_ms, tool_calls, tool_failures, stop_reason, error, error_code }",
  turn_stopped: "a turn stopped from loki's Stop button { aborted, turn_id }",
  tool_used: "the agent called a desk tool { tool }",
};

/** For each event, the property the report breaks it down by. */
export const BREAKDOWN: Record<string, string> = {
  view_opened: "view",
  desk_switched: "desk",
  turn_finished: "origin",
  message_sent: "origin",
  model_switched: "model",
  mode_set: "mode",
  command_run: "command",
  tool_used: "tool",
  widget_gestured: "kind",
  approval_decided: "behavior",
  approval_requested: "kind",
  inbox_card_decided: "action",
  inbox_card_undone: "action",
  inbox_filtered: "agent",
  chat_archived: "origin",
  chat_restored: "origin",
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
  windows: number;
  linux: number;
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
  inbox: { passes: number; decided: number; perPass: number | null; next: number; archive: number; approve: number; deny: number; replies: number };
  /**
   * The metric the inbox's ranking is tuned for: how much you engage. `actions` are your messages, answers and
   * decisions; of the Inbox cards you decided, `engaged` are the ones you replied to, answered or decided rather
   * than cleared or put off, with where they stood in the queue (rank 1 is the card on top): a ranking that
   * reads you well puts what you engage with first.
   */
  engagement: {
    actions: number;
    perActiveDay: number | null;
    cards: number;
    engaged: number;
    top: number;
    medianRank: number | null;
    byReason: Array<[string, { cards: number; engaged: number }]>;
    /** Distinct chats among the engaged cards (repeat replies to one chat count once); null before cards carried `desk`. */
    chats: number | null;
    /** Cards shown at the top, and by the rank each stood at when shown (1, 2, 3, 4+), how many of those showings you engaged with (once each). */
    shown: number;
    byRank: Array<[string, { shown: number; engaged: number }]>;
    /** Nexts and Archives taken back. */
    undone: number;
    /** Nexts straight after you acted on the same card (a reply leaves the card in place and → moves on): not skips, left out of the cards above. */
    movedOn: number;
    /** Minutes from an agent's turn ending to your next reply, answer, decision or open in that chat (median). */
    respondMinutes: number | null;
    /** Minutes an approval or question waited for you (median). */
    decideMinutes: number | null;
  };
  /** The daemon's turns (turn_finished with its measurements), by model and by harness version, most turns first. */
  harness: { turns: number; byModel: HarnessRow[]; byVersion: HarnessRow[] };
  /** Events by local hour of day (24) and weekday (7, Sunday first). */
  hours: number[];
  weekdays: number[];
  neverFired: string[];
}

/** One group of turns: the spread of where their time went, what they cost, and how often they failed. */
export interface HarnessRow {
  key: string;
  turns: number;
  ttftMs: Spread;
  overheadMs: Spread;
  totalMs: Spread;
  /** Mean cost of a turn, in the provider's currency (dollars). */
  costPerTurn: number | null;
  /** Of every prompt token sent, the share read from the cache. */
  cacheShare: number | null;
  /** Turns that ended in an error. */
  errorRate: number | null;
  /** Tool calls that failed, of all tool calls. */
  toolFailureRate: number | null;
}
export type Spread = { p50: number | null; p90: number | null };

/** A turn as the harness section reads it from a turn_finished line; null for a line from before the daemon measured turns. */
type MeasuredTurn = { model: string; version: string; ttft: number | null; overhead: number; total: number; cost: number; prompt: number; cacheRead: number; error: boolean; tools: number; toolFailures: number };
function measuredTurn(p: Record<string, unknown>): MeasuredTurn | null {
  if (typeof p.total_ms !== "number") return null;
  return {
    model: typeof p.model === "string" ? p.model : "unknown",
    version: typeof p.harness_version === "string" ? p.harness_version : "unknown",
    ttft: typeof p.ttft_ms === "number" ? p.ttft_ms : null,
    overhead: num(p.overhead_ms),
    total: p.total_ms,
    cost: num(p.cost),
    prompt: num(p.input_tokens) + num(p.cache_read_tokens) + num(p.cache_write_tokens),
    cacheRead: num(p.cache_read_tokens),
    error: p.error === true,
    tools: num(p.tool_calls),
    toolFailures: num(p.tool_failures),
  };
}

/** The value at or below which `q` of the values fall (nearest rank); null for none. */
export function percentile(values: readonly number[], q: number): number | null {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil(q * s.length) - 1))];
}
const spread = (values: number[]): Spread => ({ p50: percentile(values, 0.5), p90: percentile(values, 0.9) });
const ratio = (n: number, of: number) => (of ? n / of : null);

function harnessRows(turns: MeasuredTurn[], keyOf: (t: MeasuredTurn) => string): HarnessRow[] {
  const groups = new Map<string, MeasuredTurn[]>();
  for (const t of turns) (groups.get(keyOf(t)) ?? groups.set(keyOf(t), []).get(keyOf(t))!).push(t);
  const sum = (ts: MeasuredTurn[], pick: (t: MeasuredTurn) => number) => ts.reduce((n, t) => n + pick(t), 0);
  return [...groups.entries()]
    .map(([key, ts]) => ({
      key,
      turns: ts.length,
      ttftMs: spread(ts.flatMap((t) => (t.ttft === null ? [] : [t.ttft]))),
      overheadMs: spread(ts.map((t) => t.overhead)),
      totalMs: spread(ts.map((t) => t.total)),
      costPerTurn: ratio(sum(ts, (t) => t.cost), ts.length),
      cacheShare: ratio(sum(ts, (t) => t.cacheRead), sum(ts, (t) => t.prompt)),
      errorRate: ratio(ts.filter((t) => t.error).length, ts.length),
      toolFailureRate: ratio(sum(ts, (t) => t.toolFailures), sum(ts, (t) => t.tools)),
    }))
    .sort((a, b) => b.turns - a.turns || a.key.localeCompare(b.key));
}

/** Turns nobody waits on: a helper's, Learn's writer's and reflection's. They are measured, but no one answers them. */
const UNATTENDED_ORIGINS: ReadonlySet<string> = new Set(["subagent", "recall", "reflection"]);

const DAY_MS = 86_400_000;
/** What counts as engaging with an Inbox card: acting on it or opening it, rather than moving past or archiving it. */
export const ENGAGED_ACTIONS: ReadonlySet<string> = new Set(["reply", "answer", "approve", "deny", "open"]);
const RANK_BUCKETS = ["1", "2", "3", "4+"];
const rankBucket = (rank: number): string => (rank >= 4 ? "4+" : String(Math.max(1, Math.round(rank))));
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
  const inbox = { passes: 0, decided: 0, perPass: null as number | null, next: 0, archive: 0, approve: 0, deny: 0, replies: 0 };
  const perPass: number[] = [];
  const engagement: AnalyticsReport["engagement"] = { actions: 0, perActiveDay: null, cards: 0, engaged: 0, top: 0, medianRank: null, byReason: [], chats: null, shown: 0, byRank: [], undone: 0, movedOn: 0, respondMinutes: null, decideMinutes: null };
  const engagedRanks: number[] = [];
  const byReason = new Map<string, { cards: number; engaged: number }>();
  const engagedChats = new Set<string>();
  const byRank = new Map<string, { shown: number; engaged: number }>(RANK_BUCKETS.map((b) => [b, { shown: 0, engaged: 0 }]));
  /** Each chat's latest showing at the top: its rank bucket, and whether it has been engaged with yet. */
  const showing = new Map<string, { bucket: string; engaged: boolean }>();
  /** Each session's last card decision: the chat, and whether you acted on it. */
  const lastCard = new Map<string, { desk: string | null; engaged: boolean }>();
  /** Chats whose agent finished a turn and has not heard from you since: desk → when. */
  const waiting = new Map<string, number>();
  const respond: number[] = [];
  const decide: number[] = [];
  const measured: MeasuredTurn[] = [];

  for (const e of events) {
    const p = e.properties;
    const t = Date.parse(e.timestamp);
    const when = new Date(t);
    const row = rows.get(e.event) ?? { event: e.event, count: 0, sessions: 0, mac: 0, windows: 0, linux: 0, phone: 0, mod: 0 };
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
    if (e.event === "message_sent" || e.event === "question_answered" || e.event === "approval_decided") engagement.actions++;
    const desk = typeof p.desk === "string" ? p.desk : null;
    if (e.event === "turn_finished") {
      if (desk && !UNATTENDED_ORIGINS.has(String(p.origin))) waiting.set(desk, t);
      const turn = measuredTurn(p);
      if (turn) measured.push(turn);
    }
    const answered = e.event === "message_sent" || e.event === "question_answered" || e.event === "approval_decided" || (e.event === "inbox_card_decided" && ENGAGED_ACTIONS.has(String(p.action)));
    if (answered && desk && waiting.has(desk)) {
      respond.push((t - waiting.get(desk)!) / 60_000);
      waiting.delete(desk);
    }
    if ((e.event === "approval_decided" || e.event === "question_answered") && typeof p.wait_ms === "number") decide.push(p.wait_ms / 60_000);
    if (e.event === "inbox_card_shown") {
      engagement.shown++;
      if (typeof p.rank === "number") {
        const bucket = rankBucket(p.rank);
        byRank.get(bucket)!.shown++;
        if (desk) showing.set(desk, { bucket, engaged: false });
      }
    }
    if (e.event === "inbox_card_undone") engagement.undone++;
    if (e.event === "inbox_card_decided") {
      const engaged = ENGAGED_ACTIONS.has(String(p.action));
      const session = typeof p.$session_id === "string" ? p.$session_id : "";
      const last = lastCard.get(session);
      lastCard.set(session, { desk, engaged });
      if (p.action === "next" && desk && last?.engaged && last.desk === desk) {
        engagement.movedOn++;
        continue;
      }
      engagement.cards++;
      const r = byReason.get(String(p.reason ?? "unknown")) ?? { cards: 0, engaged: 0 };
      r.cards++;
      if (engaged) {
        engagement.engaged++;
        r.engaged++;
        if (desk) engagedChats.add(desk);
        const shownAs = desk ? showing.get(desk) : undefined;
        if (shownAs && !shownAs.engaged) {
          shownAs.engaged = true;
          byRank.get(shownAs.bucket)!.engaged++;
        }
        if (typeof p.rank === "number") {
          engagedRanks.push(p.rank);
          if (p.rank === 1) engagement.top++;
        }
      }
      byReason.set(String(p.reason ?? "unknown"), r);
    }
    if (e.event === "inbox_pass_completed") {
      inbox.passes++;
      inbox.decided += num(p.decided);
      perPass.push(num(p.decided));
      inbox.next += num(p.next);
      inbox.archive += num(p.archive);
      inbox.approve += num(p.approve);
      inbox.deny += num(p.deny);
      inbox.replies += num(p.replies);
    }
  }
  inbox.perPass = median(perPass);
  engagement.medianRank = median(engagedRanks);
  engagement.perActiveDay = activeDays.size ? Math.round((engagement.actions / activeDays.size) * 10) / 10 : null;
  engagement.byReason = [...byReason.entries()].sort((a, b) => b[1].cards - a[1].cards);
  engagement.chats = engagedChats.size || null;
  engagement.byRank = engagement.shown ? [...byRank.entries()] : [];
  engagement.respondMinutes = median(respond);
  engagement.decideMinutes = median(decide);
  for (const row of rows.values()) row.sessions = eventSessions.get(row.event)?.size ?? 0;
  const byDevice: Record<DeviceType, number> = { mac: 0, windows: 0, linux: 0, phone: 0, mod: 0 };
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
    engagement,
    harness: { turns: measured.length, byModel: harnessRows(measured, (t) => t.model), byVersion: harnessRows(measured, (t) => t.version) },
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
  // Windows and Linux get their words and columns once they have events; a Mac-only log reads as it always has.
  const devices = DEVICE_TYPES.filter((d) => (d !== "windows" && d !== "linux") || r.events.some((e) => e[d] > 0));
  out.push(`  sessions ${s.count} (${devices.map((d) => `${d} ${s.byDevice[d]}`).join(" · ")}) · median ${s.medianMinutes === null ? "–" : `${Math.round(s.medianMinutes)} min`} · ${s.perActiveDay ?? "–"} an active day`);
  const width = Math.max(12, ...r.events.map((e) => e.event.length));
  out.push("", `${"event".padEnd(width + 2)} ${"count".padStart(6)} ${"sessions".padStart(8)} ${devices.map((d) => d.padStart(Math.max(6, d.length))).join(" ")}`);
  for (const e of r.events) out.push(`  ${e.event.padEnd(width)} ${cell(e.count)} ${cell(e.sessions, 8)} ${devices.map((d) => cell(e[d], Math.max(6, d.length))).join(" ")}`);
  if (r.breakdowns.length) {
    out.push("", "breakdowns");
    const bw = Math.max(...r.breakdowns.map((b) => b.event.length + b.property.length + 3));
    for (const b of r.breakdowns) out.push(`  ${`${b.event} · ${b.property}`.padEnd(bw)}  ${b.values.map(([v, n]) => `${v} ${n}`).join(" · ")}`);
  }
  const i = r.inbox;
  if (i.passes) out.push("", `inbox passes ${i.passes} · ${i.decided} cards · median ${i.perPass} a pass · next ${pct(i.next, i.decided)} · archive ${pct(i.archive, i.decided)} · approve ${pct(i.approve, i.decided)} · deny ${pct(i.deny, i.decided)} · ${i.replies} replies`);
  const g = r.engagement;
  out.push("", `engagement ${g.actions} messages, answers and decisions · ${g.perActiveDay ?? "–"} an active day`);
  if (g.cards) {
    out.push(`  inbox cards ${g.cards} · engaged ${pct(g.engaged, g.cards)} · of those, the top card ${pct(g.top, g.engaged)} · median rank ${g.medianRank ?? "–"}`);
    out.push(`  by reason ${g.byReason.map(([reason, v]) => `${reason} ${v.engaged}/${v.cards}`).join(" · ")}`);
    if (g.chats !== null) out.push(`  engaged with ${g.chats} distinct chat${g.chats === 1 ? "" : "s"} · undone ${g.undone}${g.movedOn ? ` · moved on after acting ${g.movedOn} (not counted)` : ""}`);
  }
  if (g.shown) out.push(`  shown ${g.shown} · engaged by rank shown ${g.byRank.map(([rank, v]) => `${rank} ${pct(v.engaged, v.shown)} of ${v.shown}`).join(" · ")}`);
  const mins = (m: number | null) => (m === null ? "–" : m < 1 ? "<1 min" : m < 90 ? `${Math.round(m)} min` : `${Math.round(m / 6) / 10} h`);
  if (g.respondMinutes !== null || g.decideMinutes !== null) out.push(`  time to respond after a turn ends ${mins(g.respondMinutes)} · an approval or question waits ${mins(g.decideMinutes)} (medians)`);
  if (r.harness.turns) {
    out.push("", `harness ${r.harness.turns} turns · p50/p90 · cost a turn, mean · cache share of prompt tokens`);
    const ms = (n: number | null) => (n === null ? "–" : n < 1000 ? `${Math.round(n)}ms` : `${(n / 1000).toFixed(1)}s`);
    const both = (s: Spread) => `${ms(s.p50)}/${ms(s.p90)}`;
    const share = (n: number | null) => (n === null ? "–" : `${Math.round(n * 100)}%`);
    const money = (n: number | null) => (n === null ? "–" : `$${n < 0.01 ? n.toFixed(4) : n.toFixed(3)}`);
    for (const [title, rows] of [["by model", r.harness.byModel], ["by harness version", r.harness.byVersion]] as const) {
      const kw = Math.max(5, ...rows.map((row) => row.key.length));
      out.push(`  ${title}`, `    ${"".padEnd(kw)} ${"turns".padStart(5)} ${"ttft".padStart(13)} ${"overhead".padStart(13)} ${"total".padStart(13)} ${"cost".padStart(8)} ${"cache".padStart(5)} ${"errors".padStart(6)} ${"tool fails".padStart(10)}`);
      for (const row of rows) out.push(`    ${row.key.padEnd(kw)} ${String(row.turns).padStart(5)} ${both(row.ttftMs).padStart(13)} ${both(row.overheadMs).padStart(13)} ${both(row.totalMs).padStart(13)} ${money(row.costPerTurn).padStart(8)} ${share(row.cacheShare).padStart(5)} ${share(row.errorRate).padStart(6)} ${share(row.toolFailureRate).padStart(10)}`);
    }
  }
  out.push("", "when", `  hour  ${bars(r.hours, (h) => (h % 6 === 0 ? String(h).padStart(2, "0") : ""))}`, `  day   ${bars(r.weekdays, (d) => WEEKDAY[d])}`);
  out.push("", `never fired: ${r.neverFired.length ? r.neverFired.join(", ") : "nothing — every event fired at least once"}`);
  return out.join("\n");
}
