import { lokiDir } from "./paths.ts";
import { existsSync, mkdirSync, renameSync } from "node:fs";
import { basename, join } from "node:path";
import { homedir } from "node:os";
import { log } from "./log.ts";
import { envVar, execProgram, firstExisting, onPath, type Look } from "./programs.ts";
import type { Task } from "../core/frame-types.ts";
import { NOTE_MAX, oneLine, sourceMetadata, type TaskSource } from "../core/task-source.ts";
import { migrateKeys, OLD_TASK_METADATA_KEYS } from "../core/snake-keys.ts";

/**
 * Tasks: the shared task list, kept by beads (`bd`, embedded Dolt) in ONE shared
 * database for every agent and folder. Agents reach it through the `tasks`
 * tool and the app through bridge frames; both land here, and every bd call runs
 * through a single serial queue (the embedded engine wants one writer).
 *
 * Every task carries the same stamp in beads' metadata: who filed it (an agent,
 * or the user from the app), from which conversation and desk, in which folder,
 * and — once assigned — which conversation should do it.
 */

/** The stamp every task carries in beads' metadata: who filed it, from which chat, desk and folder. */
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

/** A task to file: its title, optional description, labels and priority (0 to 4, clamped), and its stamp. */
export interface CreateTask {
  title: string;
  description?: string;
  labels?: string[];
  priority?: number;
  stamp: TaskStamp;
}

/** The chat a task is assigned to: its conversation and desk, and the agent's name and id when known. */
export interface AssignTarget {
  agent: string | null;
  agentId: string | null;
  conversation: string;
  desk: string;
}

/** Runs bd with the given arguments, without the binary, and resolves to its stdout; TaskStore takes one so tests need no bd. */
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
export const DONE_ASKED = ["done_asked", "done_asked_by", "done_asked_at"] as const;

/**
 * The bd arguments that record an agent's word that a task is done (DONE_ASKED), stamped with the time and, when
 * known, who said it.
 */
export function askDoneArgs(id: string, ask: { reason?: string | null; by?: string | null }, now = new Date()): string[] {
  const args = ["update", id, "--set-metadata", `done_asked=${ask.reason?.trim() || "yes"}`, "--set-metadata", `done_asked_at=${now.toISOString()}`];
  if (ask.by) args.push("--set-metadata", `done_asked_by=${ask.by}`);
  return [...args, "--json"];
}

/** The newest progress note, on the task itself: its opening on one line, and when. */
export const LAST_NOTE = ["last_note", "last_note_at"] as const;

/** The bd arguments that keep a progress note on the task (LAST_NOTE): its opening on one line, and the time. */
export function noteArgs(id: string, text: string, now = new Date()): string[] {
  return ["update", id, "--set-metadata", `last_note=${oneLine(text, NOTE_MAX)}`, "--set-metadata", `last_note_at=${now.toISOString()}`, "--json"];
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

/** A field of bd's JSON as text: a string as it is, a number or boolean written out, an object as JSON, `or` when missing. */
const fieldText = (v: unknown, or = ""): string => {
  if (v === undefined || v === null) return or;
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean" || typeof v === "bigint") return String(v);
  return JSON.stringify(v);
};

/** bd's JSON, from `bd list --json`, `bd create --json`, `bd update --json`, into loki's shape. */
export function parseTask(raw: Record<string, unknown>): Task {
  const md = (raw.metadata && typeof raw.metadata === "object" ? raw.metadata : {}) as Record<string, unknown>;
  const metadata: Record<string, string> = {};
  for (const [k, v] of Object.entries(md)) if (v != null) metadata[k] = fieldText(v);
  // Keys saved camelCase before October 2026 read under their names now; TaskStore.list rewrites them in beads once.
  const { value: current } = migrateKeys(metadata, OLD_TASK_METADATA_KEYS);
  return {
    id: fieldText(raw.id),
    title: fieldText(raw.title),
    description: typeof raw.description === "string" ? raw.description : "",
    status: fieldText(raw.status, "open"),
    priority: typeof raw.priority === "number" ? raw.priority : Number(raw.priority ?? 2) || 2,
    labels: Array.isArray(raw.labels) ? (raw.labels as unknown[]).filter((l): l is string => typeof l === "string") : [],
    assignee: typeof raw.assignee === "string" && raw.assignee ? raw.assignee : null,
    created_at: fieldText(raw.created_at),
    updated_at: fieldText(raw.updated_at ?? raw.created_at),
    closed_at: typeof raw.closed_at === "string" ? raw.closed_at : null,
    metadata: current,
  };
}

/**
 * The bd arguments that move a task's metadata off its camelCase keys from before October 2026 (each value set under
 * its new key, the old key unset), or null when it has none. Exported for tests.
 */
export function metadataMigrationArgs(raw: Record<string, unknown>): string[] | null {
  const id = fieldText(raw.id);
  const md = raw.metadata && typeof raw.metadata === "object" ? (raw.metadata as Record<string, unknown>) : {};
  const old = Object.keys(md).filter((k) => OLD_TASK_METADATA_KEYS[k] !== undefined);
  if (!id || !taskIds([id]).length || !old.length) return null;
  const args = ["update", id];
  for (const k of old) {
    const value = md[k];
    const now = OLD_TASK_METADATA_KEYS[k];
    if (now && value != null && md[now] == null) args.push("--set-metadata", `${now}=${fieldText(value)}`);
    args.push("--unset-metadata", k);
  }
  return [...args, "--json"];
}

/**
 * Tasks from bd's JSON output, a list or a single object; empty for no output. Text before the JSON is skipped, and
 * anything else that is not JSON throws.
 */
export function parseTasks(stdout: string): Task[] {
  return rawTasks(stdout).map(parseTask);
}

/** bd's JSON output as the objects it holds, before parseTask: a list or a single object; empty for no output. */
function rawTasks(stdout: string): Array<Record<string, unknown>> {
  const text = stdout.trim();
  if (!text) return [];
  // bd prints warnings to stderr, but be tolerant of a stray line before the JSON.
  const start = Math.min(...["[", "{"].map((c) => text.indexOf(c)).filter((i) => i >= 0));
  const parsed: unknown = JSON.parse(Number.isFinite(start) ? text.slice(start) : text);
  const list = Array.isArray(parsed) ? parsed : parsed && typeof parsed === "object" ? [parsed] : [];
  return list.filter((r): r is Record<string, unknown> => !!r && typeof r === "object");
}

/** The bd arguments for one create, without the binary. Exported for tests. */
export function createArgs(t: CreateTask): string[] {
  const labels = [...new Set([...(t.labels ?? []), projectLabel(t.stamp.folder)].filter((l): l is string => !!l))];
  const metadata: Record<string, string> = { by: t.stamp.by };
  if (t.stamp.agent) metadata.agent = t.stamp.agent;
  if (t.stamp.agentId) metadata.agent_id = t.stamp.agentId;
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
export interface CloseAs {
  actor?: string | null;
  force?: boolean;
}

/** The bd arguments that close tasks, as `as` says (CloseAs), with the reason when one is given. */
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

/**
 * The bd arguments that assign tasks to a chat (assigned_to, assigned_desk, the agent and the time), and start them when
 * the status is in_progress.
 */
export function assignArgs(ids: string[], target: AssignTarget, status: "open" | "in_progress" = "open"): string[] {
  const args = ["update", ...ids, "--set-metadata", `assigned_to=${target.conversation}`, "--set-metadata", `assigned_desk=${target.desk}`, "--json"];
  if (target.agent) args.push("--assignee", target.agent, "--set-metadata", `assigned_agent=${target.agent}`);
  if (target.agentId) args.push("--set-metadata", `assigned_agent_id=${target.agentId}`);
  args.push("--set-metadata", `assigned_at=${new Date().toISOString()}`);
  if (status === "in_progress") args.push("--status", "in_progress");
  return args;
}

/** A priority as bd takes it: rounded into 0 to 4, and 2 when missing. */
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
  const mine = tasks.filter((t) => t.metadata.assigned_to === opts.conversation && t.status !== "closed");
  if (!mine.length) return null;
  const lines = mine.map((t) => {
    // bd's metadata as the task file holds it: any key may be missing.
    const md: Partial<Record<string, string>> = t.metadata;
    const from = md.by === "you" ? "filed by the user" : `filed by ${md.agent ?? "an agent"}`;
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
    'Add progress with tasks {action:"comment", id, text}. When the whole task is done, call {action:"close", id, reason}: one the user filed then waits for the user to confirm.',
    "</loki-tasks>",
  ].join("\n");
}

/** Sent once when the last of a conversation's tasks is closed or moved elsewhere. */
export const TASKS_CLEARED = "<loki-tasks>\nNo tasks are assigned to this conversation in the user's Tasks any more.\n</loki-tasks>";

/**
 * What each conversation was last told about its tasks. The block rides along only when it would say something
 * new (a task assigned, closed, edited or started), not on every message: the agent keeps the earlier one in
 * its history, and `tasks` {action:"list"} reads the task list whenever it wants. Held in memory, so a restart of the mod
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
        (err: unknown) => {
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
            const msg = (stderr || err.message)
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
      const out = await this.run(args);
      const tasks = parseTasks(out);
      // Tasks still on their camelCase metadata keys move to the new ones, one bd call each, the first time they are seen.
      for (const migrateArgs of rawTasks(out)
        .map((r) => metadataMigrationArgs(r))
        .filter((a): a is string[] => a !== null))
        await this.run(migrateArgs).catch((err: unknown) =>
          log("tasks:migrate-failed", { id: migrateArgs[1], error: err instanceof Error ? err.message : String(err) }),
        );
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
    if (!t.title.trim()) return Promise.reject(new Error("a task needs a title"));
    return this.serial(async () => {
      const task = parseTasks(await this.run(createArgs(t))).at(0);
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
