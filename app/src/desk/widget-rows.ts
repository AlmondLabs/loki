import type { Scope, WidgetChange, WidgetLogEntry } from "../../../core/desk-core.ts";
import type { TranscriptRow } from "../../../core/attention/transcript.ts";
import type { WidgetMark } from "../chat/transcript";

export type WidgetLogs = Record<Scope, WidgetLogEntry[]>;

const CHANGES: readonly WidgetChange[] = ["added", "changed", "removed"];

export function parseWidgetEntry(v: unknown): WidgetLogEntry | null {
  if (typeof v !== "object" || v === null) return null;
  const e = v as Record<string, unknown>;
  const ok =
    typeof e.id === "string" &&
    typeof e.at === "number" &&
    Number.isFinite(e.at) &&
    typeof e.scope === "string" &&
    typeof e.widget_id === "string" &&
    typeof e.name === "string" &&
    typeof e.title === "string" &&
    typeof e.kind === "string" &&
    CHANGES.includes(e.change as WidgetChange);
  return ok ? (e as unknown as WidgetLogEntry) : null;
}

const byTime = (list: WidgetLogEntry[]) => [...list].sort((a, b) => a.at - b.at);

export function withEntry(store: WidgetLogs, entry: WidgetLogEntry): WidgetLogs {
  const list = store[entry.scope] ?? [];
  const i = list.findIndex((e) => e.id === entry.id);
  if (i >= 0 && list[i].at === entry.at && list[i].change === entry.change && list[i].title === entry.title) return store;
  const next = i >= 0 ? list.map((e, k) => (k === i ? entry : e)) : [...list, entry];
  return { ...store, [entry.scope]: byTime(next) };
}

export function withHistoryLog(store: WidgetLogs, scope: Scope, entries: unknown): WidgetLogs {
  const got = (Array.isArray(entries) ? entries : []).map(parseWidgetEntry).filter((e): e is WidgetLogEntry => !!e);
  const merged = new Map<string, WidgetLogEntry>();
  for (const e of [...got, ...(store[scope] ?? [])]) {
    const had = merged.get(e.id);
    if (!had || e.at > had.at) merged.set(e.id, e);
  }
  return { ...store, [scope]: byTime([...merged.values()]) };
}

export const SESSION_START = Date.now();

const whoOf = (e: WidgetLogEntry, agentName: string | null) => (e.by === "you" ? "You" : e.by === "loki" ? "loki" : (agentName ?? "the agent"));

export function widgetMarks(
  rows: TranscriptRow[] | undefined,
  log: WidgetLogEntry[] | undefined,
  agentName: string | null,
  liveSince: number = SESSION_START,
): WidgetMark[] {
  if (!rows || !log?.length) return [];
  const times = rows.map((r) => (r.at ? Date.parse(r.at) : Number.NaN));
  const latest = new Map<string, WidgetLogEntry>();
  const sorted = byTime(log);
  for (const e of sorted) latest.set(e.widget_id, e);
  const mark = (e: WidgetLogEntry, before: number): WidgetMark => ({
    id: e.id,
    before,
    at: new Date(e.at).toISOString(),
    who: whoOf(e, agentName),
    change: e.change,
    title: e.title || e.name,
    widgetId: e.widget_id,
    gone: e.change === "removed" || latest.get(e.widget_id)?.change === "removed",
  });
  if (rows.length && !times.some(Number.isFinite)) {
    const older = sorted.filter((e) => e.at < liveSince);
    const live = sorted.filter((e) => e.at >= liveSince).map((e) => mark(e, rows.length));
    const last = older.at(-1);
    return last ? [{ ...mark(last, rows.length), id: "earlier", earlier: older.length }, ...live] : live;
  }
  return sorted.map((e) => {
    const next = times.findIndex((t) => Number.isFinite(t) && t > e.at);
    return mark(e, next < 0 ? rows.length : next);
  });
}
