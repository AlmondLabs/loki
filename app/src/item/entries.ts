import type { TranscriptRow } from "../../../core/attention/transcript.ts";
import { clockLabel, dayPills } from "../shared/thread";
import { isWorkRow, stepFailed, toolRuns, workDuration } from "../shared/tool-steps";
import type { WidgetMark } from "../chat/transcript";

/**
 * One thing the new thread draws (plan 096, U5), in reading order. Rows keep their thread-wide index; a stretch of work
 * is one entry for all its rows. Keys count past `above`, the rows an older page put in front since the thread opened,
 * so an entry keeps its key, its memo and its own state (a stretch left open) when a page arrives above it.
 */
export type ThreadEntry =
  | { kind: "day"; key: string; label: string }
  | { kind: "new"; key: string; day: string | null }
  | { kind: "widget"; key: string; mark: WidgetMark; live: boolean }
  | { kind: "steps"; key: string; rows: TranscriptRow[]; running: boolean; arrived: boolean }
  | { kind: "event"; key: string; row: TranscriptRow; arrived: boolean }
  | { kind: "message"; key: string; row: TranscriptRow; last: boolean; first: boolean; arrived: boolean };

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
  /**
   * Liquid Glass tells time at gaps (plan 2026-11-12-1505, U14): before your message when this many ms or more have
   * passed since the row before, a marker with its time, and the day's marker carries the time where both fall. Unset,
   * only the day is marked.
   */
  gaps?: number;
  /** Rows from this index on came in while the thread was open. */
  arrivedFrom: number;
  now?: number;
}

/**
 * The thread as entries: each row's widget marks, a day marker where the calendar day changes (only when the rows carry
 * times), the New line, then the row itself: a message, an event, or the first row of a stretch of work standing for
 * the whole stretch. A widget mark, a day or the New line ends a stretch and starts a new run of messages.
 */
export function threadEntries({ rows, from, above, dividerAt, dividerDay, widgets, busy, arrivedFrom, gaps, now = Date.now() }: EntryInput): ThreadEntry[] {
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

  // Where a time marker goes (gaps): your message, a gap or more after the timed row before it, or the first one.
  const timeAt = new Map<number, string>();
  if (gaps !== undefined && timed) {
    let before = Number.NaN;
    order.forEach((o) => {
      const t = o.row?.at ? Date.parse(o.row.at) : Number.NaN;
      if (!Number.isFinite(t)) return;
      const clock = o.row?.role === "user" ? clockLabel(o.row.at) : null;
      if (clock && !(t - before < gaps)) timeAt.set(o.i, clock);
      before = t;
    });
  }

  const out: ThreadEntry[] = [];
  let author: TranscriptRow["role"] | null = null;
  order.forEach((o, k) => {
    const label = days[k];
    const clock = o.row ? timeAt.get(o.i) : undefined;
    if (label) {
      out.push({ kind: "day", key: `day-${label}`, label: clock ? `${label} ${clock}` : label });
      author = null;
    } else if (clock) {
      out.push({ kind: "day", key: `at-${o.i - above}`, label: clock });
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
    out.push({ kind: "message", key, row: m, last: i === rows.length - 1, first: speaks && m.role !== author, arrived });
    if (speaks) author = m.role;
  });
  return out;
}

/**
 * A part of the agent's turn: its words, a stretch of its work, an event, a widget it changed, or a day or the New line
 * that fell inside it. A marker inside a turn is drawn where it fell and does not end the turn, so coming back to a chat
 * mid-turn shows one turn with the New line in it, not two turns with the agent's name twice.
 */
export type TurnPart = Extract<ThreadEntry, { kind: "message" | "steps" | "event" | "widget" | "day" | "new" }>;

/** What the turn header says about where the turn stands. */
export type TurnState = "working" | "needs you" | "failed" | "done";

/**
 * The thread as Turns draws it (plan 096, U6): your messages stand alone, and so do the day and New markers that fall
 * between turns; everything the agent did between two of your messages (its words, stretches of work, events, widget
 * changes, and any marker among them) is one turn, keyed by its first part so it keeps its key as it grows.
 */
export type TurnEntry =
  | Extract<ThreadEntry, { kind: "day" | "new" }>
  | Extract<ThreadEntry, { kind: "message" }>
  | { kind: "turn"; key: string; parts: TurnPart[]; state: TurnState; failed: number; took: string | null };

/**
 * Groups the entries into turns. Only the last turn can be working (the agent is busy) or waiting on you (an approval or
 * a question is open). Before that a turn reads failed only when its last step failed: a step the agent got past is
 * still counted on its work line, but the turn did not fail. How long it took comes from the times on its rows.
 */
export function threadTurns(entries: ThreadEntry[], { busy, waiting }: { busy: boolean; waiting: boolean }): TurnEntry[] {
  const out: TurnEntry[] = [];
  let open: TurnPart[] | null = null;
  // Markers met while a turn is open wait here: the agent's next part takes them into its turn, your next message
  // leaves them standing between turns.
  let held: Array<Extract<ThreadEntry, { kind: "day" | "new" }>> = [];
  const close = () => {
    const parts: TurnPart[] | null = open;
    open = null;
    if (!parts || parts.length === 0) return;
    const rows = parts.flatMap((p) => (p.kind === "steps" ? p.rows : p.kind === "message" || p.kind === "event" ? [p.row] : []));
    const work = rows.filter(isWorkRow);
    const failed = work.filter(stepFailed).length;
    const tail = work.at(-1);
    out.push({ kind: "turn", key: `turn-${parts[0].key}`, parts, state: tail && stepFailed(tail) ? "failed" : "done", failed, took: workDuration(rows) });
  };
  for (const e of entries) {
    if (e.kind === "day" || e.kind === "new") {
      if (open) held.push(e);
      else out.push(e);
    } else if (e.kind === "message" && e.row.role === "user") {
      close();
      out.push(...held, e);
      held = [];
    } else {
      (open ??= []).push(...held, e);
      held = [];
    }
  }
  close();
  // The live turn is the last one, with only the markers it held after it.
  const at = out.length - 1;
  const last = out.at(-1);
  if (last?.kind === "turn" && (busy || waiting)) out[at] = { ...last, state: waiting ? "needs you" : "working" };
  out.push(...held);
  return out;
}
