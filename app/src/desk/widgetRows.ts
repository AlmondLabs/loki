import type { Scope, WidgetChange, WidgetLogEntry } from "../../../core/desk-core.ts";
import type { TranscriptRow } from "../../../core/attention/transcript.ts";
import type { WidgetMark } from "../chat/Transcript";

/**
 * Widget rows in the thread (plan 013 U8), pure (test/widget-rows.test.ts): the per-desk store of the
 * mod's widget change log (mod/widget-log.ts), fed by history replies and live `widget_change` frames,
 * and where each entry sits among a thread's messages.
 */

export type WidgetLogs = Record<Scope, WidgetLogEntry[]>;

const CHANGES: readonly WidgetChange[] = ["added", "changed", "removed"];

/** A `widget_change` frame's entry (or one row of a history reply's `widgetLog`), or null when it is not one. */
export function parseWidgetEntry(v: unknown): WidgetLogEntry | null {
  if (typeof v !== "object" || v === null) return null;
  const e = v as Record<string, unknown>;
  const ok =
    typeof e.id === "string" &&
    typeof e.at === "number" &&
    Number.isFinite(e.at) &&
    typeof e.scope === "string" &&
    typeof e.widgetId === "string" &&
    typeof e.name === "string" &&
    typeof e.title === "string" &&
    typeof e.kind === "string" &&
    CHANGES.includes(e.change as WidgetChange);
  return ok ? (e as unknown as WidgetLogEntry) : null;
}

/** Oldest first; a sort that keeps log order among equal times. */
const byTime = (list: WidgetLogEntry[]) => [...list].sort((a, b) => a.at - b.at);

/**
 * The store with one entry in, under its own desk. A collapsed repeat edit keeps its row's id with a
 * later `at`: it replaces that row and moves to its new time. The same entry again changes nothing.
 */
export function withEntry(store: WidgetLogs, entry: WidgetLogEntry): WidgetLogs {
  const list = store[entry.scope] ?? [];
  const i = list.findIndex((e) => e.id === entry.id);
  if (i >= 0 && list[i].at === entry.at && list[i].change === entry.change && list[i].title === entry.title) return store;
  const next = i >= 0 ? list.map((e, k) => (k === i ? entry : e)) : [...list, entry];
  return { ...store, [entry.scope]: byTime(next) };
}

/**
 * A history reply's log for one desk, merged with what arrived live while it was on the way: by id, the
 * later time wins. Other desks are left as they are.
 */
export function withHistoryLog(store: WidgetLogs, scope: Scope, entries: unknown): WidgetLogs {
  const got = (Array.isArray(entries) ? entries : []).map(parseWidgetEntry).filter((e): e is WidgetLogEntry => !!e);
  const merged = new Map<string, WidgetLogEntry>();
  for (const e of [...got, ...(store[scope] ?? [])]) {
    const had = merged.get(e.id);
    if (!had || e.at > had.at) merged.set(e.id, e);
  }
  return { ...store, [scope]: byTime([...merged.values()]) };
}

/**
 * The thread's widget rows: each log entry placed before the first message timed after it (after the
 * latest one when none is), so it reads among the messages by time. Rows without a time keep their
 * arrival order and place nothing. A row is `gone` when it removed the widget or a later entry did: choosing
 * it frames nothing.
 */
export function widgetMarks(rows: TranscriptRow[] | undefined, log: WidgetLogEntry[] | undefined, agentName: string | null): WidgetMark[] {
  if (!rows || !log?.length) return [];
  const times = rows.map((r) => (r.at ? Date.parse(r.at) : Number.NaN));
  const latest = new Map<string, WidgetLogEntry>();
  const sorted = byTime(log);
  for (const e of sorted) latest.set(e.widgetId, e);
  return sorted.map((e) => {
    const next = times.findIndex((t) => Number.isFinite(t) && t > e.at);
    return {
      id: e.id,
      before: next < 0 ? rows.length : next,
      at: new Date(e.at).toISOString(),
      agent: agentName ?? "the agent",
      change: e.change,
      title: e.title || e.name,
      widgetId: e.widgetId,
      gone: e.change === "removed" || latest.get(e.widgetId)?.change === "removed",
    };
  });
}
