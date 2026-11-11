import type { TranscriptRow } from "../../../../core/attention/transcript.ts";
import { dayPills } from "../../shared/thread";
import { isWorkRow, toolRuns } from "../../shared/tool-steps";
import type { WidgetMark } from "../transcript";

/**
 * One thing the new thread draws (plan 094, U5), in reading order. Rows keep their thread-wide index; a stretch of work
 * is one entry for all its rows. Keys count past `above`, the rows an older page put in front since the thread opened,
 * so an entry keeps its key, its memo and its own state (a stretch left open) when a page arrives above it.
 */
export type ThreadEntry =
  | { kind: "day"; key: string; label: string }
  | { kind: "new"; key: string; day: string | null }
  | { kind: "widget"; key: string; mark: WidgetMark; live: boolean }
  | { kind: "steps"; key: string; rows: TranscriptRow[]; running: boolean; arrived: boolean }
  | { kind: "event"; key: string; row: TranscriptRow; arrived: boolean }
  | { kind: "message"; key: string; row: TranscriptRow; last: boolean; first: boolean; arrived: boolean; anchor: boolean };

/** What the entries are built from: the thread's rows and where its window starts, and the marks laid among them. */
export interface EntryInput {
  rows: TranscriptRow[];
  /** The first row mounted (the window, transcript-window.ts). */
  from: number;
  /** Rows loaded above since the thread opened. */
  above: number;
  /** The New line sits before this row. */
  dividerAt: number | null;
  /** The day named beside the New line when the rows carry no times. */
  dividerDay: string | null;
  widgets: readonly WidgetMark[];
  /** The agent is working: a last stretch still waiting on its result reads as running. */
  busy: boolean;
  /** Rows from this index on came in while the thread was open. */
  arrivedFrom: number;
  now?: number;
}

/**
 * The thread as entries: each row's widget marks, a day marker where the calendar day changes (only when the rows carry
 * times), the New line, then the row itself: a message, an event, or the first row of a stretch of work standing for
 * the whole stretch. A widget mark, a day or the New line ends a stretch and starts a new run of messages.
 */
export function threadEntries({ rows, from, above, dividerAt, dividerDay, widgets, busy, arrivedFrom, now = Date.now() }: EntryInput): ThreadEntry[] {
  const first = Math.max(0, Math.min(from, rows.length));
  const marks = new Map<number, WidgetMark[]>();
  for (const w of widgets) if (w.before >= first) marks.set(w.before, [...(marks.get(w.before) ?? []), w]);
  // Each widget is drawn live once, under its latest row.
  const latest = new Map<string, string>();
  for (const w of widgets) if (w.earlier === undefined) latest.set(w.widgetId, w.id);

  // Reading order, so a day is named at whatever opens it, a message or a widget row.
  const order: Array<{ i: number; row?: TranscriptRow; mark?: WidgetMark }> = [];
  for (let i = first; i <= rows.length; i++) {
    for (const mark of marks.get(i) ?? []) order.push({ i, mark });
    if (i < rows.length) order.push({ i, row: rows[i] });
  }
  const timed = order.some((o) => o.row?.at && Number.isFinite(Date.parse(o.row.at)));
  const days = timed
    ? dayPills(
        order.map((o) => o.row ?? o.mark ?? {}),
        now,
      )
    : order.map(() => null);
  const dayAt = new Set<number>();
  order.forEach((o, k) => {
    if (days[k] && o.row) dayAt.add(o.i);
  });
  const tools = toolRuns(rows, first, (k) => marks.has(k) || dayAt.has(k) || k === dividerAt);

  const out: ThreadEntry[] = [];
  let author: TranscriptRow["role"] | null = null;
  order.forEach((o, k) => {
    const label = days[k];
    if (label) {
      out.push({ kind: "day", key: `day-${label}`, label });
      author = null;
    }
    if (o.mark) {
      const w = o.mark;
      out.push({ kind: "widget", key: `w-${w.id}`, mark: w, live: !w.gone && latest.get(w.widgetId) === w.id });
      author = null;
      return;
    }
    const m = o.row;
    if (!m) return;
    const i = o.i;
    const key = `r-${i - above}`;
    if (dividerAt === i) {
      out.push({ kind: "new", key: `new-${key}`, day: timed ? null : dividerDay });
      author = null;
    }
    const arrived = i >= arrivedFrom;
    if (isWorkRow(m)) {
      const end = tools.get(i);
      if (end === undefined) return;
      const run = rows.slice(i, end);
      const tail = run[run.length - 1];
      // A lean row from a page finished; only the live tail of the thread can still be running.
      const running = busy && end === rows.length && tail.role === "tool" && !tail.tool?.output && tail.tool?.row === undefined;
      out.push({ kind: "steps", key, rows: run, running, arrived });
      return;
    }
    if (m.role === "event") {
      out.push({ kind: "event", key, row: m, arrived });
      return;
    }
    const speaks = m.role === "user" || m.role === "assistant";
    out.push({ kind: "message", key, row: m, last: i === rows.length - 1, first: speaks && m.role !== author, arrived, anchor: m.role === "user" });
    if (speaks) author = m.role;
  });
  return out;
}
