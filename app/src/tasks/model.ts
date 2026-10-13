import type { Task } from "../../../core/frame-types.ts";

export type ColumnId = "open" | "in_progress" | "blocked" | "done";

/** One column of the Board layout: a status, an assignee or a folder, and its tasks in order. */
export interface Column {
  id: string;
  label: string;
  tasks: Task[];
}

export const PRIORITY_LABEL = ["P0", "P1", "P2", "P3", "P4"] as const;

/** The status a task counts as: open takes deferred and pinned, in progress takes hooked, closed is done whatever its age. Any other status is off the list. */
export function columnOf(t: Task): ColumnId | null {
  if (t.status === "open" || t.status === "deferred" || t.status === "pinned") return "open";
  if (t.status === "in_progress" || t.status === "hooked") return "in_progress";
  if (t.status === "blocked") return "blocked";
  if (t.status === "closed") return "done";
  return null;
}

export const STATUS_LABEL: Record<ColumnId, string> = { open: "Open", in_progress: "In progress", blocked: "Blocked", done: "Done · 7d" };
const COLUMN_IDS: ColumnId[] = ["open", "in_progress", "blocked", "done"];
const DONE_WINDOW_MS = 7 * 24 * 3600_000;

/**
 * An agent said it finished a task the person filed: the task waits for the person to confirm it (Confirm closes it)
 * or reopen it (mod/tasks.ts askDone). Until then it is open, with the agent's word on it.
 */
export const isWaiting = (t: Task): boolean => !!t.metadata.doneAsked && t.status !== "closed";

/** Open tasks by priority, then the most recently moved; done ones after them, the latest first. */
function byListOrder(a: Task, b: Task): number {
  const ad = a.status === "closed";
  const bd = b.status === "closed";
  if (ad !== bd) return ad ? 1 : -1;
  if (ad) return (b.closedAt ?? "").localeCompare(a.closedAt ?? "");
  return a.priority - b.priority || (b.updatedAt || "").localeCompare(a.updatedAt || "");
}

/** The tasks the list shows at all: every one with a known status, done ones only from the last week. */
export function shownTasks(tasks: Task[], now = Date.now()): Task[] {
  return tasks.filter((t) => {
    const status = columnOf(t);
    if (!status) return false;
    return status !== "done" || !t.closedAt || now - new Date(t.closedAt).getTime() < DONE_WINDOW_MS;
  });
}

/** Four columns: open (and deferred), in progress, blocked, and what was closed in the last week. */
export function columnsOf(tasks: Task[], now = Date.now()): Column[] {
  const shown = shownTasks(tasks, now);
  return COLUMN_IDS.map((id) => ({ id, label: STATUS_LABEL[id], tasks: shown.filter((t) => columnOf(t) === id).sort(byListOrder) }));
}

/**
 * The views in the Tasks sidebar, all built in: every task, the ones you filed that no chat has taken (Mine), the ones
 * an agent says are done and wait for you, and one per agent with tasks.
 */
export type TaskViewId = "all" | "mine" | "waiting" | `agent:${string}`;

export interface ViewRow {
  view: TaskViewId;
  label: string;
  count: number;
}

const agentOf = (view: TaskViewId): string | null => (view.startsWith("agent:") ? view.slice("agent:".length) : null);

/** Yours to do: filed by you and not assigned to any chat. */
export const isMine = (t: Task): boolean => t.metadata.by === "you" && !t.metadata.assignedTo;

/** The tasks a view shows, from those the list shows at all. */
export function viewTasks(tasks: Task[], view: TaskViewId, now = Date.now()): Task[] {
  const shown = shownTasks(tasks, now);
  const agent = agentOf(view);
  if (agent !== null) return shown.filter((t) => t.assignee === agent);
  if (view === "mine") return shown.filter(isMine);
  if (view === "waiting") return shown.filter(isWaiting);
  return shown;
}

/** The sidebar's views, each with the number of tasks it shows: All, Mine, Waiting for you, then each agent with tasks (by name). */
export function taskViews(tasks: Task[], now = Date.now()): { views: ViewRow[]; agents: ViewRow[] } {
  const shown = shownTasks(tasks, now);
  const perAgent = new Map<string, number>();
  for (const t of shown) if (t.assignee) perAgent.set(t.assignee, (perAgent.get(t.assignee) ?? 0) + 1);
  return {
    views: [
      { view: "all", label: "All", count: shown.length },
      { view: "mine", label: "Mine", count: shown.filter(isMine).length },
      { view: "waiting", label: "Waiting for you", count: shown.filter(isWaiting).length },
    ],
    agents: [...perAgent].sort(([a], [b]) => a.localeCompare(b)).map(([name, count]) => ({ view: `agent:${name}` as const, label: name, count })),
  };
}

/** How a view lays its tasks out: the Board's columns, or the Table's rows. */
export type Layout = "board" | "table";
/** What the Board's columns are. */
export type GroupBy = "status" | "assignee" | "folder";
export type SortKey = "title" | "status" | "assignee" | "by" | "chat" | "folder" | "updated";
export interface Sort {
  key: SortKey;
  dir: "asc" | "desc";
}
/** A view's layout settings: remembered per view on this device, never a view of their own. */
export interface ViewPrefs {
  layout: Layout;
  groupBy: GroupBy;
  sort: Sort;
}
export const DEFAULT_PREFS: ViewPrefs = { layout: "board", groupBy: "status", sort: { key: "updated", dir: "desc" } };

const LAYOUTS: Layout[] = ["board", "table"];
const GROUPS: GroupBy[] = ["status", "assignee", "folder"];
const SORT_KEYS: SortKey[] = ["title", "status", "assignee", "by", "chat", "folder", "updated"];

/** A view's stored settings read back; whatever is missing or unknown is the default. */
export function parsePrefs(raw: unknown): ViewPrefs {
  const v = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const sort = (v.sort && typeof v.sort === "object" ? v.sort : {}) as Record<string, unknown>;
  return {
    layout: LAYOUTS.includes(v.layout as Layout) ? (v.layout as Layout) : DEFAULT_PREFS.layout,
    groupBy: GROUPS.includes(v.groupBy as GroupBy) ? (v.groupBy as GroupBy) : DEFAULT_PREFS.groupBy,
    sort: { key: SORT_KEYS.includes(sort.key as SortKey) ? (sort.key as SortKey) : DEFAULT_PREFS.sort.key, dir: sort.dir === "asc" ? "asc" : sort.dir === "desc" ? "desc" : DEFAULT_PREFS.sort.dir },
  };
}

/** The last part of a folder's path, as the list names it. */
export const folderName = (folder: string | undefined): string | null => (folder ? folder.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || folder : null);

/** Who filed it: you, or the agent by name. */
export const filedBy = (t: Task): string => (t.metadata.by === "you" ? "you" : t.metadata.agent ?? "an agent");

/**
 * The Board's columns for a view's tasks. By status, always the four (an empty one says so). By assignee or folder,
 * one per name in alphabetical order, with the tasks that have none in a first column of their own.
 */
export function boardColumns(tasks: Task[], groupBy: GroupBy, now = Date.now()): Column[] {
  if (groupBy === "status") {
    const shown = shownTasks(tasks, now);
    return COLUMN_IDS.map((id) => ({ id, label: STATUS_LABEL[id], tasks: shown.filter((t) => columnOf(t) === id).sort(byListOrder) }));
  }
  const keyOf = groupBy === "assignee" ? (t: Task) => t.assignee : (t: Task) => folderName(t.metadata.folder);
  const none = groupBy === "assignee" ? "Unassigned" : "No folder";
  const groups = new Map<string, Task[]>();
  for (const t of shownTasks(tasks, now)) {
    const key = keyOf(t) ?? "";
    (groups.get(key) ?? groups.set(key, []).get(key)!).push(t);
  }
  return [...groups]
    .sort(([a], [b]) => (a === "" ? -1 : b === "" ? 1 : a.localeCompare(b)))
    .map(([key, list]) => ({ id: `${groupBy}:${key}`, label: key || none, tasks: list.sort(byListOrder) }));
}

/** A task's value in a Table column, as text to sort by; `chat` names the desk a task came from. */
export function cellText(t: Task, key: SortKey, chat: (desk: string) => string): string {
  switch (key) {
    case "title":
      return t.title;
    case "status":
      return isWaiting(t) ? "done?" : STATUS_LABEL[columnOf(t) ?? "open"].replace(" · 7d", "");
    case "assignee":
      return t.assignee ?? "";
    case "by":
      return filedBy(t);
    case "chat":
      return t.metadata.desk ? chat(t.metadata.desk) : "";
    case "folder":
      return folderName(t.metadata.folder) ?? "";
    case "updated":
      return (t.status === "closed" ? t.closedAt : t.updatedAt) ?? "";
  }
}

/** The Table's rows: sorted by a column, ties in list order; an empty cell sorts last either way. */
export function tableRows(tasks: Task[], sort: Sort, chat: (desk: string) => string = (d) => d, now = Date.now()): Task[] {
  const status = (t: Task) => (isWaiting(t) ? -1 : COLUMN_IDS.indexOf(columnOf(t) ?? "open"));
  return shownTasks(tasks, now).sort((a, b) => {
    const sign = sort.dir === "asc" ? 1 : -1;
    if (sort.key === "status") return sign * (status(a) - status(b)) || byListOrder(a, b);
    const x = cellText(a, sort.key, chat);
    const y = cellText(b, sort.key, chat);
    if (!x !== !y) return x ? -1 : 1;
    return sign * x.localeCompare(y, undefined, { sensitivity: "base" }) || byListOrder(a, b);
  });
}

/** A Table header's click: the same column flips its direction, a new one starts where it reads best (newest first for a time). */
export const nextSort = (sort: Sort, key: SortKey): Sort => (sort.key === key ? { key, dir: sort.dir === "asc" ? "desc" : "asc" } : { key, dir: key === "updated" ? "desc" : "asc" });

/**
 * The view to show, and the agent it names when that agent no longer has a task in the list (its sidebar shows no
 * such row): the view stands and the pane asks for a new pick, rather than switching to All behind your back. Null
 * tasks are still loading, so nothing is missing until they arrive.
 */
export function resolveTaskView(view: TaskViewId, tasks: Task[] | null, now = Date.now()): { view: TaskViewId; missing: string | null } {
  const agent = agentOf(view);
  if (!tasks || agent === null) return { view, missing: null };
  return { view, missing: taskViews(tasks, now).agents.some((a) => a.view === view) ? null : agent };
}

/** What the pane says in place of a missing agent's tasks. */
export const missingAgentLine = (agent: string): string => `${agent} isn't here any more — pick an agent`;

/** A stored view read back; anything unknown (the Board's old status views among them) is All. */
export function parseTaskView(raw: string | null | undefined): TaskViewId {
  if (raw === "all" || raw === "mine" || raw === "waiting") return raw;
  if (raw?.startsWith("agent:") && raw.length > "agent:".length) return raw as TaskViewId;
  return "all";
}

export type Dir = "up" | "down" | "left" | "right";

/**
 * The card the cursor would land on, or null when there is nowhere to go: up and down within its column,
 * sideways to the nearest non-empty column, same row or the last one there. A single list (the Table) has no sideways.
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
    one ? "Please pick up this task from my task list:" : `Please pick up these ${tasks.length} tasks from my task list:`,
    ...lines,
    "",
    one ? "When it is done, close it with loki_task { action: \"close\", id, reason }. Ask if anything is unclear before starting." : "Work them in order unless one blocks another. Close each with loki_task { action: \"close\", id, reason } as you finish. Ask if anything is unclear before starting.",
  ].join("\n");
}
