import { execFile } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { basename, join } from "node:path";
import { homedir } from "node:os";
import { log } from "./log.ts";

/**
 * The board: tasks for later, kept by beads (`bd`, embedded Dolt) in ONE shared
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
}

export interface Task {
  id: string;
  title: string;
  description: string;
  status: string;
  priority: number;
  labels: string[];
  assignee: string | null;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  /** Free-form; loki uses by/agent/agentId/conversation/desk/folder and assignedTo/assignedDesk/assignedAgent. */
  metadata: Record<string, string>;
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

/** Where the shared board lives; LOKI_BOARD_DIR for tests and experiments. */
export const boardDir = (): string => process.env.LOKI_BOARD_DIR ?? join(homedir(), ".letta", "loki", "board");

export function bdBinary(): string | null {
  const onPath = (process.env.PATH ?? "").split(":").filter(Boolean).map((d) => join(d, "bd"));
  const candidates = [process.env.LOKI_BD, ...onPath, "/opt/homebrew/bin/bd", "/usr/local/bin/bd", join(homedir(), "go", "bin", "bd"), join(homedir(), ".local", "bin", "bd")].filter((p): p is string => !!p);
  return candidates.find((p) => existsSync(p)) ?? null;
}

/** The one-time `bd init` for the shared board. Exported for tests. */
export const INIT_ARGS = ["init", "--prefix", "lk", "--non-interactive"];

/** A label for the project a task came from: the folder's name, lower-cased, safe for bd. */
export function projectLabel(folder: string | null | undefined): string | null {
  if (!folder) return null;
  const name = basename(folder).toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
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
  const args = ["create", t.title.trim(), "-t", "task", "-p", String(clampPriority(t.priority)), "--metadata", JSON.stringify(metadata), "--json"];
  if (t.description?.trim()) args.push("-d", t.description.trim());
  if (labels.length) args.push("-l", labels.join(","));
  return args;
}

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
    `Tasks assigned to this conversation on the user's board (${mine.length}):`,
    ...lines,
    "Pick one up when the user's message is about it or when asked to work the board; otherwise acknowledge briefly and carry on.",
    "When you finish one, call loki_task {action:\"close\", id, reason}. Add progress with {action:\"comment\", id, text}.",
    "</loki-tasks>",
  ].join("\n");
}

/** Runs bd against the shared board, one call at a time. */
export class TaskBoard {
  private queue: Promise<unknown> = Promise.resolve();
  private cache: Task[] = [];
  private cacheAt = 0;
  readonly dir: string;
  private readonly run: Runner;

  constructor(opts: { dir?: string; run?: Runner } = {}) {
    this.dir = opts.dir ?? boardDir();
    this.run = opts.run ?? ((args) => this.exec(args));
  }

  /** The board exists when `bd init` has been run in its directory. */
  ready(): boolean {
    return existsSync(join(this.dir, ".beads"));
  }

  private initialising: Promise<void> | null = null;

  /** The board exists when `bd init` has been run in its directory; the first call creates it. */
  private ensure(bin: string): Promise<void> {
    if (this.ready()) return Promise.resolve();
    if (!this.initialising) {
      log("board:init", { dir: this.dir });
      mkdirSync(this.dir, { recursive: true });
      this.initialising = this.spawn(bin, INIT_ARGS).then(
        () => undefined,
        (err) => {
          this.initialising = null; // try again next time
          throw new Error(`could not create the board at ${this.dir}: ${err instanceof Error ? err.message : String(err)}`);
        },
      );
    }
    return this.initialising;
  }

  private async exec(args: string[]): Promise<string> {
    const bin = bdBinary();
    if (!bin) throw new Error("bd (beads) is not installed — brew install beads");
    await this.ensure(bin);
    return this.spawn(bin, args);
  }

  private spawn(bin: string, args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      execFile(
        bin,
        args,
        { cwd: this.dir, env: { ...process.env, BEADS_DIR: join(this.dir, ".beads"), BD_NON_INTERACTIVE: "1" }, timeout: 20_000, maxBuffer: 16 * 1024 * 1024 },
        (err, stdout, stderr) => {
          if (err) {
            const msg = String(stderr || err.message).trim().split("\n").filter((l) => !l.startsWith("warning:") && !l.trim().startsWith("Fix:") && !l.trim().startsWith("Or:")).join(" ");
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
    if (!ids.length) return Promise.resolve([]);
    return this.serial(async () => {
      const tasks = parseTasks(await this.run(assignArgs(ids, target, status)));
      log("tasks:assign", { ids, to: target.conversation, agent: target.agent, status });
      this.merge(tasks);
      return tasks;
    });
  }

  close(ids: string[], reason?: string): Promise<Task[]> {
    if (!ids.length) return Promise.resolve([]);
    return this.serial(async () => {
      const args = ["close", ...ids, "--json"];
      if (reason?.trim()) args.push("--reason", reason.trim());
      const tasks = parseTasks(await this.run(args));
      log("tasks:close", { ids, reason });
      this.cache = this.cache.filter((c) => !ids.includes(c.id));
      return tasks;
    });
  }

  reopen(ids: string[]): Promise<Task[]> {
    if (!ids.length) return Promise.resolve([]);
    return this.serial(async () => {
      const tasks = parseTasks(await this.run(["reopen", ...ids, "--json"]));
      this.merge(tasks);
      return tasks;
    });
  }

  setStatus(ids: string[], status: "open" | "in_progress" | "blocked" | "deferred"): Promise<Task[]> {
    if (!ids.length) return Promise.resolve([]);
    return this.serial(async () => {
      const tasks = parseTasks(await this.run(["update", ...ids, "--status", status, "--json"]));
      this.merge(tasks);
      return tasks;
    });
  }

  comment(id: string, text: string): Promise<void> {
    if (!text.trim()) return Promise.reject(new Error("an empty comment"));
    return this.serial(async () => {
      await this.run(["comment", id, text.trim()]);
      log("tasks:comment", { id });
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
