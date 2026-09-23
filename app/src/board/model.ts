import type { Task } from "../../../mod/tasks.ts";

export type { Task };

export type ColumnId = "open" | "in_progress" | "blocked" | "done";

export interface Column {
  id: ColumnId;
  label: string;
  tasks: Task[];
}

export const PRIORITY_LABEL = ["P0", "P1", "P2", "P3", "P4"] as const;

/** Four columns: open (and deferred), in progress, blocked, and what was closed in the last week. */
export function columnsOf(tasks: Task[], now = Date.now(), doneWindowMs = 7 * 24 * 3600_000): Column[] {
  const byPriorityThenAge = (a: Task, b: Task) => a.priority - b.priority || (b.updatedAt || "").localeCompare(a.updatedAt || "");
  const open = tasks.filter((t) => t.status === "open" || t.status === "deferred" || t.status === "pinned").sort(byPriorityThenAge);
  const inProgress = tasks.filter((t) => t.status === "in_progress" || t.status === "hooked").sort(byPriorityThenAge);
  const blocked = tasks.filter((t) => t.status === "blocked").sort(byPriorityThenAge);
  const done = tasks
    .filter((t) => t.status === "closed" && (!t.closedAt || now - new Date(t.closedAt).getTime() < doneWindowMs))
    .sort((a, b) => (b.closedAt ?? "").localeCompare(a.closedAt ?? ""));
  return [
    { id: "open", label: "Open", tasks: open },
    { id: "in_progress", label: "In progress", tasks: inProgress },
    { id: "blocked", label: "Blocked", tasks: blocked },
    { id: "done", label: "Done · 7d", tasks: done },
  ];
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
