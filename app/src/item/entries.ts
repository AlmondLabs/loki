import type { TranscriptRow } from "../../../core/attention/transcript.ts";
import { clockLabel, dayPills } from "../shared/thread";
import { isWorkRow, stepFailed, toolRuns, workDuration } from "../shared/tool-steps";
import type { WidgetMark } from "../chat/transcript";

export type ThreadEntry =
  | { kind: "day"; key: string; label: string }
  | { kind: "new"; key: string; day: string | null }
  | { kind: "widget"; key: string; mark: WidgetMark; live: boolean }
  | { kind: "steps"; key: string; rows: TranscriptRow[]; running: boolean; arrived: boolean }
  | { kind: "event"; key: string; row: TranscriptRow; arrived: boolean }
  | { kind: "message"; key: string; row: TranscriptRow; last: boolean; first: boolean; arrived: boolean };

export interface EntryInput {
  rows: TranscriptRow[];
  from: number;
  above: number;
  dividerAt: number | null;
  dividerDay: string | null;
  widgets: readonly WidgetMark[];
  busy: boolean;
  gaps?: number;
  arrivedFrom: number;
  now?: number;
}

export function threadEntries({ rows, from, above, dividerAt, dividerDay, widgets, busy, arrivedFrom, gaps, now = Date.now() }: EntryInput): ThreadEntry[] {
  let liveEnd = rows.length;
  while (liveEnd > 0 && rows[liveEnd - 1].event === "command") liveEnd--;
  const first = Math.max(0, Math.min(from, rows.length));
  const marks = new Map<number, WidgetMark[]>();
  for (const w of widgets) if (w.before >= first) marks.set(w.before, [...(marks.get(w.before) ?? []), w]);
  const latest = new Map<string, string>();
  for (const w of widgets) if (w.earlier === undefined) latest.set(w.widgetId, w.id);

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
      const running = busy && end === liveEnd && tail.role === "tool" && !tail.tool?.output && tail.tool?.row === undefined;
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

export type TurnPart = Extract<ThreadEntry, { kind: "message" | "steps" | "event" | "widget" | "day" | "new" }>;

export type TurnState = "working" | "needs you" | "failed" | "done";

export type TurnEntry =
  | Extract<ThreadEntry, { kind: "day" | "new" }>
  | Extract<ThreadEntry, { kind: "message" }>
  | { kind: "command"; key: string; row: TranscriptRow; arrived: boolean }
  | { kind: "turn"; key: string; parts: TurnPart[]; state: TurnState; failed: number; took: string | null };

const opensTurn = (p: TurnPart): boolean => p.kind === "event" && (p.row.event === "advisor" || p.row.event === "chat_message");
const onlyOpeners = (parts: readonly TurnPart[]): boolean => parts.every((p) => p.kind === "day" || p.kind === "new" || opensTurn(p));

export function threadTurns(entries: ThreadEntry[], { busy, waiting }: { busy: boolean; waiting: boolean }): TurnEntry[] {
  const out: TurnEntry[] = [];
  let open: TurnPart[] | null = null;
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
    } else if (e.kind === "event" && e.row.event === "command") {
      close();
      out.push(...held, { kind: "command", key: e.key, row: e.row, arrived: e.arrived });
      held = [];
    } else if (opensTurn(e) && open !== null && !onlyOpeners(open)) {
      close();
      out.push(...held);
      held = [];
      open = [e];
    } else {
      (open ??= []).push(...held, e);
      held = [];
    }
  }
  close();
  let at = out.length - 1;
  while (at >= 0 && out[at].kind === "command") at--;
  const last = out.at(at);
  if (last?.kind === "turn" && (busy || waiting)) out[at] = { ...last, state: waiting ? "needs you" : "working" };
  out.push(...held);
  return out;
}

export function thoughtsIntoWork(turns: ReadonlyArray<readonly TurnPart[]>): { into: Map<string, TranscriptRow[]>; folded: Set<string> } {
  const into = new Map<string, TranscriptRow[]>();
  const folded = new Set<string>();
  for (const parts of turns)
    parts.forEach((p, i) => {
      const before = i > 0 ? parts[i - 1] : null;
      if (p.kind !== "message" || !p.row.thought || before?.kind !== "steps") return;
      into.set(before.key, [...(into.get(before.key) ?? []), p.row]);
      folded.add(p.key);
    });
  return { into, folded };
}
