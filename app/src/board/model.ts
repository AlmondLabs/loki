import type { Task } from "../../../mod/tasks.ts";

export type { Task };

export type ColumnId = "open" | "in_progress" | "blocked" | "done";

export interface Column {
  /** A status column, or "agent" for the one list an agent's view shows. */
  id: ColumnId | "agent";
  label: string;
  tasks: Task[];
}

export const PRIORITY_LABEL = ["P0", "P1", "P2", "P3", "P4"] as const;

/** The column a task's status puts it in: open takes deferred and pinned, in progress takes hooked, closed is done whatever its age. Any other status is off the board. */
export function columnOf(t: Task): ColumnId | null {
  if (t.status === "open" || t.status === "deferred" || t.status === "pinned") return "open";
  if (t.status === "in_progress" || t.status === "hooked") return "in_progress";
  if (t.status === "blocked") return "blocked";
  if (t.status === "closed") return "done";
  return null;
}

const COLUMN_LABEL: Record<ColumnId, string> = { open: "Open", in_progress: "In progress", blocked: "Blocked", done: "Done · 7d" };
const COLUMN_IDS: ColumnId[] = ["open", "in_progress", "blocked", "done"];

/** Four columns: open (and deferred), in progress, blocked, and what was closed in the last week. */
export function columnsOf(tasks: Task[], now = Date.now(), doneWindowMs = 7 * 24 * 3600_000): Column[] {
  const byPriorityThenAge = (a: Task, b: Task) => a.priority - b.priority || (b.updatedAt || "").localeCompare(a.updatedAt || "");
  const byClosed = (a: Task, b: Task) => (b.closedAt ?? "").localeCompare(a.closedAt ?? "");
  const recent = (t: Task) => !t.closedAt || now - new Date(t.closedAt).getTime() < doneWindowMs;
  return COLUMN_IDS.map((id) => ({
    id,
    label: COLUMN_LABEL[id],
    tasks: tasks.filter((t) => columnOf(t) === id && (id !== "done" || recent(t))).sort(id === "done" ? byClosed : byPriorityThenAge),
  }));
}

/**
 * What the board pane shows (plan 013 U11): every task as the four columns, one status column, or one
 * agent's tasks as a single list. An agent view is keyed by the name the task is assigned to.
 */
export type BoardView = "all" | ColumnId | `agent:${string}`;

export interface ViewRow {
  view: BoardView;
  label: string;
  count: number;
}

const agentOf = (view: BoardView): string | null => (view.startsWith("agent:") ? view.slice("agent:".length) : null);

/** The board's views for the list column, each with the number of tasks it shows: all, each status, then each agent with tasks on the board (by name). */
export function boardViews(tasks: Task[], now = Date.now()): { views: ViewRow[]; agents: ViewRow[] } {
  const columns = columnsOf(tasks, now);
  const onBoard = columns.flatMap((c) => c.tasks);
  const perAgent = new Map<string, number>();
  for (const t of onBoard) if (t.assignee) perAgent.set(t.assignee, (perAgent.get(t.assignee) ?? 0) + 1);
  return {
    views: [{ view: "all", label: "All tasks", count: onBoard.length }, ...columns.map((c) => ({ view: c.id as ColumnId, label: c.label, count: c.tasks.length }))],
    agents: [...perAgent].sort(([a], [b]) => a.localeCompare(b)).map(([name, count]) => ({ view: `agent:${name}` as const, label: name, count })),
  };
}

/** The columns a view shows: all four for "all", else a single one — the status's, or the agent's tasks in board order. */
export function viewColumns(tasks: Task[], view: BoardView, now = Date.now()): Column[] {
  const columns = columnsOf(tasks, now);
  const agent = agentOf(view);
  if (agent !== null) return [{ id: "agent", label: agent, tasks: columns.flatMap((c) => c.tasks.filter((t) => t.assignee === agent)) }];
  if (view === "all") return columns;
  return columns.filter((c) => c.id === view);
}

/**
 * The view to show: an agent view whose agent no longer has a task on the board (its column lists no such
 * row) is the whole board. Null tasks are still loading, so the view stands until they arrive.
 */
export function resolveBoardView(view: BoardView, tasks: Task[] | null, now = Date.now()): BoardView {
  if (!tasks || !agentOf(view)) return view;
  return boardViews(tasks, now).agents.some((a) => a.view === view) ? view : "all";
}

/** A stored view read back; anything unknown is the whole board. */
export function parseBoardView(raw: string | null | undefined): BoardView {
  if (raw === "all" || COLUMN_IDS.includes(raw as ColumnId)) return raw as BoardView;
  if (raw?.startsWith("agent:") && raw.length > "agent:".length) return raw as BoardView;
  return "all";
}

export type Dir = "up" | "down" | "left" | "right";

/**
 * The card the cursor would land on, or null when there is nowhere to go: up and down within its column,
 * sideways to the nearest non-empty column, same row or the last one there. A single list has no sideways.
 */
export function stepCursor(columns: Column[], cursor: string | null, dir: Dir): string | null {
  if (!cursor) return columns.flatMap((c) => c.tasks)[0]?.id ?? null;
  const ci = columns.findIndex((c) => c.tasks.some((t) => t.id === cursor));
  if (ci < 0) return null;
  const col = columns[ci];
  const i = col.tasks.findIndex((t) => t.id === cursor);
  if (dir === "up" || dir === "down") {
    const next = col.tasks[Math.max(0, Math.min(col.tasks.length - 1, i + (dir === "down" ? 1 : -1)))];
    return next && next.id !== cursor ? next.id : null;
  }
  let j = ci;
  do j += dir === "right" ? 1 : -1;
  while (j >= 0 && j < columns.length && columns[j].tasks.length === 0);
  const target = columns[j];
  return target ? target.tasks[Math.min(i, target.tasks.length - 1)].id : null;
}

/** Type-to-filter over title, id, labels, and who filed it. */
export function filterTasks(tasks: Task[], query: string): Task[] {
  const q = query.trim().toLowerCase();
  if (!q) return tasks;
  return tasks.filter((t) => t.title.toLowerCase().includes(q) || t.id.toLowerCase().includes(q) || t.labels.some((l) => l.toLowerCase().includes(q)) || (t.metadata.agent ?? "").toLowerCase().includes(q));
}

/**
 * The message a dispatch posts into the target conversation. Plain and complete: the agent
 * may be starting cold, and the ids let it close the tasks through loki_task.
 */
export function dispatchMessage(tasks: Task[]): string {
  const one = tasks.length === 1;
  const lines = tasks.map((t) => {
    const head = `- ${t.id} · ${PRIORITY_LABEL[t.priority] ?? "P2"} · ${t.title}`;
    const from = t.metadata.by === "you" ? "filed by me" : t.metadata.agent ? `filed by ${t.metadata.agent}` : null;
    const where = t.metadata.folder ? `in ${t.metadata.folder}` : null;
    const meta = [from, where].filter(Boolean).join(", ");
    const desc = t.description.trim() ? `\n  ${t.description.trim().replace(/\n/g, "\n  ")}` : "";
    return `${head}${meta ? ` (${meta})` : ""}${desc}`;
  });
  return [
    one ? "Please pick up this task from my board:" : `Please pick up these ${tasks.length} tasks from my board:`,
    ...lines,
    "",
    one ? "When it is done, close it with loki_task { action: \"close\", id, reason }. Ask if anything is unclear before starting." : "Work them in order unless one blocks another. Close each with loki_task { action: \"close\", id, reason } as you finish. Ask if anything is unclear before starting.",
  ].join("\n");
}

export function ago(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return "";
  const m = Math.max(0, Math.round((now - new Date(iso).getTime()) / 60000));
  if (m < 1) return "now";
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}
