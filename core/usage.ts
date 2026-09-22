/**
 * The usage log: what you did in loki, one JSON line per action, in ~/.letta/loki/logs/usage.jsonl.
 * Local only — the mod writes it, nothing reads it but `bun run usage` on this machine. Ids and counts, never
 * message text, titles or paths. This module is the shape and the arithmetic; mod/usage.ts appends lines,
 * mod/bridge.ts and the app decide when, scripts/usage.ts turns the file into answers.
 */

/** Who did it: the Mac window, a paired phone, or the mod itself (turns and tools, whichever client they came from). */
export type UsageSurface = "mac" | "phone" | "mod";
export const USAGE_SURFACES: readonly UsageSurface[] = ["mac", "phone", "mod"];

export interface UsageLine {
  /** ISO time. */
  at: string;
  surface: UsageSurface;
  action: string;
  detail?: Record<string, unknown>;
}

/** Every action recorded, with what its detail carries. The report lists the ones that did not happen in the window. */
export const USAGE_ACTIONS: Record<string, string> = {
  view: "a view opened { to, from } — the Mac's segments, the phone's tabs and pages",
  desk: "the desk on screen changed { scope }",
  chat: "the desk chat opened or closed { open }",
  send: "a message went out { origin: desk | inbox | lesson, images, queued }",
  approve: "a tool permission decided { behavior }",
  answer: "an agent's question answered",
  command: "a harness slash command run { id }",
  model: "a conversation's model switched { handle, effort }",
  mode: "a conversation's permission mode set { mode }",
  pass: "an inbox pass ended { decided, next, later, approve, deny, replies }",
  seen: "a conversation marked seen",
  unread: "a conversation kept unread",
  later: "a card deferred { skips }",
  unsnooze: "a deferral cleared",
  pin: "a desk pinned or unpinned { pinned }",
  gesture: "a widget moved, resized, opened, closed or set { kind }",
  arrange: "a desk tidied",
  trash: "a widget deleted",
  turn: "an agent turn started, typed anywhere (the terminal included) { desk }",
  tool: "the agent used a desk tool { tool }",
};
/** Action names are short lowercase words; anything else from a client is refused. */
export const USAGE_ACTION_RE = /^[a-z][a-z_]{0,39}$/;

export function isUsageSurface(value: unknown): value is UsageSurface {
  return typeof value === "string" && (USAGE_SURFACES as readonly string[]).includes(value);
}

export function usageLine(surface: UsageSurface, action: string, detail?: Record<string, unknown>, now: Date = new Date()): UsageLine {
  return { at: now.toISOString(), surface, action, ...(detail && Object.keys(detail).length ? { detail } : {}) };
}

/** Parse the file's text; a line that is not a usage line (cut short, hand-edited) is skipped, not fatal. */
export function parseUsage(text: string): UsageLine[] {
  const out: UsageLine[] = [];
  for (const raw of text.split("\n")) {
    if (!raw.trim()) continue;
    try {
      const v = JSON.parse(raw) as Record<string, unknown>;
      if (typeof v.at !== "string" || Number.isNaN(Date.parse(v.at)) || !isUsageSurface(v.surface) || typeof v.action !== "string") continue;
      out.push({ at: v.at, surface: v.surface, action: v.action, ...(v.detail && typeof v.detail === "object" ? { detail: v.detail as Record<string, unknown> } : {}) });
    } catch {
      // not ours
    }
  }
  return out;
}

export interface UsageReport {
  window: { from: string | null; to: string | null; days: number; lines: number; activeDays: number };
  surfaces: Record<UsageSurface, number>;
  /** Views by name, most visited first. */
  views: Array<[string, number]>;
  inbox: {
    passes: number;
    decided: number;
    /** Cards decided per pass, the median; null with no passes. */
    perPass: number | null;
    next: number;
    later: number;
    approve: number;
    deny: number;
    replies: number;
    /** Swipes on the phone's deck: it has no pass, so its seen and later lines are the count. */
    phone: { seen: number; later: number };
  };
  desks: { turns: number; byDesk: Array<[string, number]>; distinct: number; switches: number };
  chat: { sends: Array<[string, number]>; images: number; queued: number; models: Array<[string, number]>; modes: Array<[string, number]>; commands: Array<[string, number]> };
  /** Lines by local hour of day (24) and by weekday (7, Sunday first). */
  hours: number[];
  weekdays: number[];
  /** Known actions with no line in the window. */
  unused: string[];
}

const DAY_MS = 86_400_000;

const tally = (m: Map<string, number>, key: string, n = 1) => m.set(key, (m.get(key) ?? 0) + n);
const ranked = (m: Map<string, number>, limit = Infinity): Array<[string, number]> => [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, limit);
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const str = (v: unknown, fallback: string): string => (typeof v === "string" && v ? v : fallback);
function median(values: number[]): number | null {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** Everything in the last `days` days up to `now`, counted the way the questions are asked. */
export function usageReport(all: UsageLine[], { now, days }: { now: number; days: number }): UsageReport {
  const since = now - days * DAY_MS;
  const lines = all.filter((l) => {
    const t = Date.parse(l.at);
    return t >= since && t <= now;
  });
  const surfaces: Record<UsageSurface, number> = { mac: 0, phone: 0, mod: 0 };
  const views = new Map<string, number>();
  const byDesk = new Map<string, number>();
  const sends = new Map<string, number>();
  const models = new Map<string, number>();
  const modes = new Map<string, number>();
  const commands = new Map<string, number>();
  const seenActions = new Set<string>();
  const activeDays = new Set<string>();
  const hours = new Array<number>(24).fill(0);
  const weekdays = new Array<number>(7).fill(0);
  const inbox = { passes: 0, decided: 0, perPass: null as number | null, next: 0, later: 0, approve: 0, deny: 0, replies: 0, phone: { seen: 0, later: 0 } };
  const perPass: number[] = [];
  let images = 0;
  let queued = 0;
  let switches = 0;

  for (const l of lines) {
    const d = l.detail ?? {};
    const when = new Date(l.at);
    surfaces[l.surface]++;
    seenActions.add(l.action);
    activeDays.add(`${when.getFullYear()}-${when.getMonth()}-${when.getDate()}`);
    hours[when.getHours()]++;
    weekdays[when.getDay()]++;
    switch (l.action) {
      case "view":
        tally(views, str(d.to, "?"));
        break;
      case "desk":
        switches++;
        break;
      case "turn":
        tally(byDesk, str(d.desk, "?"));
        break;
      case "send":
        tally(sends, str(d.origin, l.surface));
        images += num(d.images);
        if (d.queued === true) queued++;
        break;
      case "model":
        tally(models, `${str(d.handle, "?")}${d.effort ? ` · ${String(d.effort)}` : ""}`);
        break;
      case "mode":
        tally(modes, str(d.mode, "?"));
        break;
      case "command":
        tally(commands, str(d.id, "?"));
        break;
      case "pass":
        inbox.passes++;
        inbox.decided += num(d.decided);
        perPass.push(num(d.decided));
        inbox.next += num(d.next);
        inbox.later += num(d.later);
        inbox.approve += num(d.approve);
        inbox.deny += num(d.deny);
        inbox.replies += num(d.replies);
        break;
      case "seen":
        if (l.surface === "phone") inbox.phone.seen++;
        break;
      case "later":
        if (l.surface === "phone") inbox.phone.later++;
        break;
    }
  }
  inbox.perPass = median(perPass);
  const stamps = lines.map((l) => Date.parse(l.at));
  return {
    window: { from: stamps.length ? new Date(Math.min(...stamps)).toISOString() : null, to: stamps.length ? new Date(Math.max(...stamps)).toISOString() : null, days, lines: lines.length, activeDays: activeDays.size },
    surfaces,
    views: ranked(views),
    inbox,
    desks: { turns: [...byDesk.values()].reduce((a, b) => a + b, 0), byDesk: ranked(byDesk, 10), distinct: byDesk.size, switches },
    chat: { sends: ranked(sends), images, queued, models: ranked(models), modes: ranked(modes), commands: ranked(commands) },
    hours,
    weekdays,
    unused: Object.keys(USAGE_ACTIONS).filter((a) => !seenActions.has(a)),
  };
}

const WEEKDAY = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const pct = (n: number, of: number) => (of ? `${Math.round((n / of) * 100)}%` : "–");
const list = (rows: Array<[string, number]>, none = "none") => (rows.length ? rows.map(([k, n]) => `  ${String(n).padStart(5)}  ${k}`).join("\n") : `         ${none}`);
/** A histogram as one line: each bucket's share as a bar glyph, so the shape reads at a glance. */
function bars(values: number[], labels: (i: number) => string): string {
  const max = Math.max(1, ...values);
  const glyphs = " ▁▂▃▄▅▆▇█";
  return values.map((v, i) => `${labels(i)}${glyphs[Math.round((v / max) * (glyphs.length - 1))]}`).join(" ");
}

/** The report as text, for the terminal. */
export function formatUsageReport(r: UsageReport): string {
  const w = r.window;
  const total = r.surfaces.mac + r.surfaces.phone + r.surfaces.mod;
  const out: string[] = [];
  out.push(`usage · last ${w.days} days${w.from ? ` · ${w.from.slice(0, 10)} → ${w.to!.slice(0, 10)}` : ""} · ${w.lines} lines on ${w.activeDays} active day${w.activeDays === 1 ? "" : "s"}`);
  if (!w.lines) return out.join("\n");
  out.push(`  mac ${pct(r.surfaces.mac, total)} · phone ${pct(r.surfaces.phone, total)} · mod ${pct(r.surfaces.mod, total)} (turns and tools)`);
  out.push("", "views opened", list(r.views));
  const i = r.inbox;
  out.push("", "inbox");
  out.push(`  ${i.passes} pass${i.passes === 1 ? "" : "es"} on the Mac · ${i.decided} cards decided · median ${i.perPass ?? "–"} per pass`);
  out.push(`  next ${i.next} · later ${i.later} · approve ${i.approve} · deny ${i.deny} · replies ${i.replies}${i.decided ? ` · later is ${pct(i.later, i.decided)} of decisions` : ""}`);
  out.push(`  phone swipes: seen ${i.phone.seen} · later ${i.phone.later}`);
  out.push("", `desks · ${r.desks.turns} turns on ${r.desks.distinct} desk${r.desks.distinct === 1 ? "" : "s"} · ${r.desks.switches} desk switches`, list(r.desks.byDesk, "no turns"));
  out.push("", "chat", `  sends by origin`, list(r.chat.sends, "no sends"), `  images ${r.chat.images} · queued mid-turn ${r.chat.queued}`);
  out.push(`  model picks`, list(r.chat.models), `  mode picks`, list(r.chat.modes), `  commands`, list(r.chat.commands));
  out.push("", "when", `  hour  ${bars(r.hours, (h) => (h % 6 === 0 ? String(h).padStart(2, "0") : ""))}`, `  day   ${bars(r.weekdays, (d) => WEEKDAY[d])}`);
  out.push("", `not used in this window: ${r.unused.length ? r.unused.join(", ") : "nothing — every action happened at least once"}`);
  return out.join("\n");
}
