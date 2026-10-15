import { lokiDir } from "./paths.ts";
import { existsSync, mkdirSync, renameSync } from "node:fs";
import { basename, join } from "node:path";
import { homedir } from "node:os";
import { log } from "./log.ts";
import { envVar, execProgram, firstExisting, onPath, type Look } from "./programs.ts";
import type { Task } from "../core/frame-types.ts";
import { NOTE_MAX, oneLine, sourceMetadata, type TaskSource } from "../core/task-source.ts";

/**
 * Tasks: the shared task list, kept by beads (`bd`, embedded Dolt) in ONE shared
 * database for every agent and folder. Agents reach it through the `loki_task`
 * tool and the app through bridge frames; both land here, and every bd call runs
 * through a single serial queue (the embedded engine wants one writer).
 *
 * Every task carries the same stamp in beads' metadata: who filed it (an agent,
 * or the user from the app), from which conversation and desk, in which folder,
 * and — once assigned — which conversation should do it.
 */

export interface TaskStamp {
  by: "agent" | "you";
  agent?: string | null;
  agentId?: string | null;
  conversation?: string | null;
  desk?: string | null;
  folder?: string | null;
  /** The chat message it was filed from (Add task): the task links back to it, and the message shows its chip. */
  source?: TaskSource;
}

export interface CreateTask {
  title: string;
  description?: string;
  labels?: string[];
  priority?: number;
  stamp: TaskStamp;
}

export interface AssignTarget {
  agent: string | null;
  agentId: string | null;
  conversation: string;
  desk: string;
}

export type Runner = (args: string[]) => Promise<string>;

/**
 * Where the shared task list lives: <loki>/tasks, or LOKI_TASKS_DIR (LOKI_BOARD_DIR, its name from before Tasks, still
 * counts) for tests and experiments. A list from when Tasks was the Board, in <loki>/board, moves here once; if it
 * cannot move (the folder is held, a permission), it is used where it is, and the move is tried again next start.
 */
export function tasksDir(home = lokiDir(), env: NodeJS.ProcessEnv = process.env): string {
  const set = env.LOKI_TASKS_DIR ?? env.LOKI_BOARD_DIR;
  if (set) return set;
  const dir = join(home, "tasks");
  const old = join(home, "board");
  if (existsSync(dir) || !existsSync(old)) return dir;
  try {
    renameSync(old, dir);
    log("tasks:moved", { from: old, to: dir });
    return dir;
  } catch (err) {
    log("tasks:move-failed", { from: old, to: dir, error: err instanceof Error ? err.message : String(err) });
    return old;
  }
}

/**
 * An agent's word that a task the person filed is done, kept on the task until the person answers: the agent's reason
 * (or "yes"), who said it, and when. Confirm closes the task; Reopen clears these (TaskStore.reopen).
 */
export const DONE_ASKED = ["doneAsked", "doneAskedBy", "doneAskedAt"] as const;

export function askDoneArgs(id: string, ask: { reason?: string | null; by?: string | null }, now = new Date()): string[] {
  const args = ["update", id, "--set-metadata", `doneAsked=${ask.reason?.trim() || "yes"}`, "--set-metadata", `doneAskedAt=${now.toISOString()}`];
  if (ask.by) args.push("--set-metadata", `doneAskedBy=${ask.by}`);
  return [...args, "--json"];
}

/** The newest progress note, on the task itself: its opening on one line, and when. */
export const LAST_NOTE = ["lastNote", "lastNoteAt"] as const;

export function noteArgs(id: string, text: string, now = new Date()): string[] {
  return ["update", id, "--set-metadata", `lastNote=${oneLine(text, NOTE_MAX)}`, "--set-metadata", `lastNoteAt=${now.toISOString()}`, "--json"];
}

/** LOKI_BD, then PATH (`bd.exe` on Windows), then Homebrew, /usr/local, Go's and ~/.local's bin. */
export function bdBinary(look: Look = {}): string | null {
  return firstExisting(
    [
      envVar("LOKI_BD", look),
      ...onPath("bd", look),
      "/opt/homebrew/bin/bd",
      "/usr/local/bin/bd",
      join(homedir(), "go", "bin", "bd"),
      join(homedir(), ".local", "bin", "bd"),
    ],
    look,
  );
}

/** The one-time `bd init` for the shared task list. Exported for tests. */
export const INIT_ARGS = ["init", "--prefix", "lk", "--non-interactive"];

/** A label for the project a task came from: the folder's name, lower-cased, safe for bd. */
export function projectLabel(folder: string | null | undefined): string | null {
  if (!folder) return null;
  const name = basename(folder)
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return name || null;
}

/** bd's JSON, from `bd list --json`, `bd create --json`, `bd update --json`, into loki's shape. */
export function parseTask(raw: Record<string, unknown>): Task {
  const md = (raw.metadata && typeof raw.metadata === "object" ? raw.metadata : {}) as Record<string, unknown>;
  const metadata: Record<string, string> = {};
  for (const [k, v] of Object.entries(md)) if (v != null) metadata[k] = String(v);
  return {
    id: String(raw.id ?? ""),
    title: String(raw.title ?? ""),
    description: typeof raw.description === "string" ? raw.description : "",
    status: String(raw.status ?? "open"),
    priority: typeof raw.priority === "number" ? raw.priority : Number(raw.priority ?? 2) || 2,
    labels: Array.isArray(raw.labels) ? (raw.labels as unknown[]).filter((l): l is string => typeof l === "string") : [],
    assignee: typeof raw.assignee === "string" && raw.assignee ? raw.assignee : null,
    createdAt: String(raw.created_at ?? ""),
    updatedAt: String(raw.updated_at ?? raw.created_at ?? ""),
    closedAt: typeof raw.closed_at === "string" ? raw.closed_at : null,
    metadata,
  };
}

export function parseTasks(stdout: string): Task[] {
  const text = stdout.trim();
  if (!text) return [];
  // bd prints warnings to stderr, but be tolerant of a stray line before the JSON.
  const start = Math.min(...["[", "{"].map((c) => text.indexOf(c)).filter((i) => i >= 0));
  const parsed: unknown = JSON.parse(Number.isFinite(start) ? text.slice(start) : text);
  const list = Array.isArray(parsed) ? parsed : parsed && typeof parsed === "object" ? [parsed] : [];
  return list.filter((r): r is Record<string, unknown> => !!r && typeof r === "object").map(parseTask);
}

/** The bd arguments for one create, without the binary. Exported for tests. */
export function createArgs(t: CreateTask): string[] {
  const labels = [...new Set([...(t.labels ?? []), projectLabel(t.stamp.folder)].filter((l): l is string => !!l))];
  const metadata: Record<string, string> = { by: t.stamp.by };
  if (t.stamp.agent) metadata.agent = t.stamp.agent;
  if (t.stamp.agentId) metadata.agentId = t.stamp.agentId;
  if (t.stamp.conversation) metadata.conversation = t.stamp.conversation;
  if (t.stamp.desk) metadata.desk = t.stamp.desk;
  if (t.stamp.folder) metadata.folder = t.stamp.folder;
  if (t.stamp.source) Object.assign(metadata, sourceMetadata(t.stamp.source));
  const args = ["create", "-t", "task", "-p", String(clampPriority(t.priority)), "--metadata", JSON.stringify(metadata), "--json"];
  if (t.description?.trim()) args.push("-d", t.description.trim());
  if (labels.length) args.push("-l", labels.join(","));
  // The title last, after `--`: one that starts with "-" (an agent's "--help", say) is a title, not an option.
  args.push("--", t.title.trim());
  return args;
}

/**
 * Who closes: beads refuses to close a task assigned to someone other than the one closing it ("reclaim or use
 * --force"), and the mod runs bd as the computer's user, never the agent. An agent closing its own chat's task closes
 * as its assignee (`actor`); the person closing from Tasks has decided, so it is forced.
 */
export type CloseAs = { actor?: string | null; force?: boolean };

export function closeArgs(ids: string[], reason?: string, as: CloseAs = {}): string[] {
  const args = ["close", ...ids];
  if (as.actor) args.push("--actor", as.actor);
  if (as.force) args.push("--force");
  args.push("--json");
  if (reason?.trim()) args.push("--reason", reason.trim());
  return args;
}

/** Ids as bd names them (lk-a1, lk-a1.2): anything else, one starting with "-" above all, is not passed to bd. */
export const taskIds = (ids: string[]): string[] => ids.filter((id) => typeof id === "string" && /^[A-Za-z0-9][\w.-]*$/.test(id));

export function assignArgs(ids: string[], target: AssignTarget, status: "open" | "in_progress" = "open"): string[] {
  const args = ["update", ...ids, "--set-metadata", `assignedTo=${target.conversation}`, "--set-metadata", `assignedDesk=${target.desk}`, "--json"];
  if (target.agent) args.push("--assignee", target.agent, "--set-metadata", `assignedAgent=${target.agent}`);
  if (target.agentId) args.push("--set-metadata", `assignedAgentId=${target.agentId}`);
  args.push("--set-metadata", `assignedAt=${new Date().toISOString()}`);
  if (status === "in_progress") args.push("--status", "in_progress");
  return args;
}

export function clampPriority(p: number | undefined): number {
  if (p === undefined || Number.isNaN(p)) return 2;
  return Math.max(0, Math.min(4, Math.round(p)));
}

const PRIORITY = ["P0", "P1", "P2", "P3", "P4"];

/**
 * The block attached to the user's next message in a conversation that has tasks
 * assigned to it. Written so the agent knows these are queued, not the request.
 */
export function formatTasksContext(tasks: Task[], opts: { conversation: string }): string | null {
  const mine = tasks.filter((t) => t.metadata.assignedTo === opts.conversation && t.status !== "closed");
  if (!mine.length) return null;
  const lines = mine.map((t) => {
    const from = t.metadata.by === "you" ? "filed by the user" : `filed by ${t.metadata.agent ?? "an agent"}`;
    const where = t.metadata.folder ? ` in ${t.metadata.folder}` : "";
    const started = t.status === "in_progress" ? " · in progress" : "";
    const desc = t.description ? `\n    ${t.description.replace(/\s+/g, " ").slice(0, 400)}` : "";
    return `- ${t.id}  ${PRIORITY[t.priority] ?? "P2"}  ${t.title} — ${from}${where}${started}${desc}`;
  });
  return [
    "<loki-tasks>",
    `Tasks assigned to this conversation in the user's Tasks (${mine.length}):`,
    ...lines,
    "Pick one up when the user's message is about it or when asked to work through Tasks; otherwise acknowledge briefly and carry on.",
    'Add progress with loki_task {action:"comment", id, text}. When the whole task is done, call {action:"close", id, reason}: one the user filed then waits for the user to confirm.',
    "</loki-tasks>",
  ].join("\n");
}

/** Sent once when the last of a conversation's tasks is closed or moved elsewhere. */
export const TASKS_CLEARED = "<loki-tasks>\nNo tasks are assigned to this conversation in the user's Tasks any more.\n</loki-tasks>";

/**
 * What each conversation was last told about its tasks. The block rides along only when it would say something
 * new (a task assigned, closed, edited or started), not on every message: the agent keeps the earlier one in
 * its history, and `loki_task list` reads the task list whenever it wants. Held in memory, so a restart of the mod
 * tells each conversation once more.
 */
export class TasksNotice {
  private told = new Map<string, string>();

  /** The block this conversation's next message should carry, or null when it would repeat the last one. */
  pending(conversation: string, tasks: Task[]): string | null {
    const block = formatTasksContext(tasks, { conversation });
    const was = this.told.get(conversation);
    if (block === null) return was === undefined ? null : TASKS_CLEARED;
    return block === was ? null : block;
  }

  /** The block went out on a message (call only once it is attached). */
  sent(conversation: string, block: string): void {
    if (block === TASKS_CLEARED) this.told.delete(conversation);
    else this.told.set(conversation, block);
  }

  /** The agent's copy is gone (the conversation was compacted): tell it again next time. */
  forget(conversation: string): void {
    this.told.delete(conversation);
  }
}

/** Runs bd against the shared task list, one call at a time. */
export class TaskStore {
  private queue: Promise<unknown> = Promise.resolve();
  private cache: Task[] = [];
  private cacheAt = 0;
  readonly dir: string;
  private readonly run: Runner;

  constructor(opts: { dir?: string; run?: Runner } = {}) {
    this.dir = opts.dir ?? tasksDir();
    this.run = opts.run ?? ((args) => this.exec(args));
  }

  /** The task list exists when `bd init` has been run in its directory. */
  ready(): boolean {
    return existsSync(join(this.dir, ".beads"));
  }

  private initialising: Promise<void> | null = null;

  /** The task list exists when `bd init` has been run in its directory; the first call creates it. */
  private ensure(bin: string): Promise<void> {
    if (this.ready()) return Promise.resolve();
    if (!this.initialising) {
      log("tasks:init", { dir: this.dir });
      mkdirSync(this.dir, { recursive: true });
      this.initialising = this.spawn(bin, INIT_ARGS).then(
        () => undefined,
        (err) => {
          this.initialising = null; // try again next time
          throw new Error(`could not create the task list at ${this.dir}: ${err instanceof Error ? err.message : String(err)}`);
        },
      );
    }
    return this.initialising;
  }

  private async exec(args: string[]): Promise<string> {
    const bin = bdBinary();
    if (!bin) throw new Error(`bd (beads) is not installed — ${process.platform === "darwin" ? "brew install beads" : "npm install -g @beads/bd"}`);
    await this.ensure(bin);
    return this.spawn(bin, args);
  }

  private spawn(bin: string, args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      execProgram(
        bin,
        args,
        { cwd: this.dir, env: { ...process.env, BEADS_DIR: join(this.dir, ".beads"), BD_NON_INTERACTIVE: "1" }, timeout: 20_000, maxBuffer: 16 * 1024 * 1024 },
        (err, stdout, stderr) => {
          if (err) {
            const msg = String(stderr || err.message)
              .trim()
              .split("\n")
              .filter((l) => !l.startsWith("warning:") && !l.trim().startsWith("Fix:") && !l.trim().startsWith("Or:"))
              .join(" ");
            reject(new Error(msg || `bd ${args[0]} failed`));
          } else resolve(stdout);
        },
      );
    });
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(fn, fn);
    this.queue = next.catch(() => undefined);
    return next;
  }

  /** Every open task (closed ones too with `all`), refreshing the cache. */
  list(opts: { all?: boolean } = {}): Promise<Task[]> {
    return this.serial(async () => {
      const args = ["list", "--json", "--flat", "-n", "0"];
      if (opts.all) args.push("--all");
      const tasks = parseTasks(await this.run(args));
      if (!opts.all) this.cache = tasks;
      else this.cache = tasks.filter((t) => t.status !== "closed");
      this.cacheAt = Date.now();
      return tasks;
    });
  }

  /** The last listing, for synchronous readers (turn_start cannot wait on bd). */
  cached(): Task[] {
    return this.cache;
  }
  cacheAge(): number {
    return this.cacheAt ? Date.now() - this.cacheAt : Infinity;
  }

  create(t: CreateTask): Promise<Task> {
    if (!t.title?.trim()) return Promise.reject(new Error("a task needs a title"));
    return this.serial(async () => {
      const [task] = parseTasks(await this.run(createArgs(t)));
      if (!task) throw new Error("bd create returned nothing");
      log("tasks:create", { id: task.id, by: t.stamp.by, agent: t.stamp.agent });
      this.cache = [...this.cache.filter((c) => c.id !== task.id), task];
      return task;
    });
  }

  assign(ids: string[], target: AssignTarget, status: "open" | "in_progress" = "open"): Promise<Task[]> {
    ids = taskIds(ids);
    if (!ids.length) return Promise.resolve([]);
    return this.serial(async () => {
      const tasks = parseTasks(await this.run(assignArgs(ids, target, status)));
      log("tasks:assign", { ids, to: target.conversation, agent: target.agent, status });
      this.merge(tasks);
      return tasks;
    });
  }

  close(ids: string[], reason?: string, as: CloseAs = {}): Promise<Task[]> {
    ids = taskIds(ids);
    if (!ids.length) return Promise.resolve([]);
    return this.serial(async () => {
      const tasks = parseTasks(await this.run(closeArgs(ids, reason, as)));
      log("tasks:close", { ids, reason });
      this.cache = this.cache.filter((c) => !ids.includes(c.id));
      return tasks;
    });
  }

  /** An agent says a task the person filed is done: it waits for the person (DONE_ASKED), still open. */
  askDone(id: string, ask: { reason?: string | null; by?: string | null }): Promise<Task[]> {
    const [one] = taskIds([id]);
    if (!one) return Promise.resolve([]);
    return this.serial(async () => {
      const tasks = parseTasks(await this.run(askDoneArgs(one, ask)));
      log("tasks:ask-done", { id: one, by: ask.by });
      this.merge(tasks);
      return tasks;
    });
  }

  /** Not done after all: an agent's done? is cleared, and a closed task opens again. */
  reopen(ids: string[]): Promise<Task[]> {
    ids = taskIds(ids);
    if (!ids.length) return Promise.resolve([]);
    return this.serial(async () => {
      const cleared = parseTasks(await this.run(["update", ...ids, ...DONE_ASKED.flatMap((k) => ["--unset-metadata", k]), "--json"]));
      const closed = cleared.filter((t) => t.status === "closed").map((t) => t.id);
      const reopened = closed.length ? parseTasks(await this.run(["reopen", ...closed, "--json"])) : [];
      const tasks = cleared.map((t) => reopened.find((r) => r.id === t.id) ?? t);
      log("tasks:reopen", { ids, reopened: closed });
      this.merge(tasks);
      return tasks;
    });
  }

  /** One task as the list has it now, closed or not; null when there is no such task. */
  async find(id: string): Promise<Task | null> {
    return (await this.list({ all: true })).find((t) => t.id === id) ?? null;
  }

  setStatus(ids: string[], status: "open" | "in_progress" | "blocked" | "deferred"): Promise<Task[]> {
    ids = taskIds(ids);
    if (!ids.length) return Promise.resolve([]);
    return this.serial(async () => {
      const tasks = parseTasks(await this.run(["update", ...ids, "--status", status, "--json"]));
      this.merge(tasks);
      return tasks;
    });
  }

  /**
   * A progress note on a task. Its opening is also kept on the task (LAST_NOTE), so the message it came from can show
   * the newest note without reading every task's comments.
   */
  comment(id: string, text: string): Promise<Task[]> {
    if (!text.trim()) return Promise.reject(new Error("an empty comment"));
    const [one] = taskIds([id]);
    if (!one) return Promise.reject(new Error(`no task ${id}`));
    return this.serial(async () => {
      await this.run(["comment", one, text.trim()]);
      const tasks = parseTasks(await this.run(noteArgs(one, text)));
      log("tasks:comment", { id: one });
      this.merge(tasks);
      return tasks;
    });
  }

  private merge(tasks: Task[]): void {
    const byId = new Map(this.cache.map((t) => [t.id, t]));
    for (const t of tasks) {
      if (t.status === "closed") byId.delete(t.id);
      else byId.set(t.id, t);
    }
    this.cache = [...byId.values()];
  }
}
