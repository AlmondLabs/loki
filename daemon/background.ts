import type { Context } from "@earendil-works/chord/context";
import { defineExtension, defineTool, type Extension, type ToolExecutionApi, type ToolRegistration } from "@earendil-works/pi-durable";
import { execFile, execFileSync, spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { AgentInfoDoc, ChatDoc } from "./kernel/index.ts";
import { shellTitle } from "../core/shell-title.ts";
import { withStepDescription } from "./step-description.ts";
import { isRecord, withKind } from "./tool-kinds.ts";

const KEEP = 256 * 1024;
const KEEP_FINISHED_MS = 60 * 60_000;
const KEEP_FINISHED = 32;
const MAX_WAIT_MS = 600_000;

interface Task {
  id: string;
  agentId: string;
  chatId: string;
  command: string;
  description: string;
  child: ChildProcess;
  output: string;
  read: number;
  exit: { code: number | null; signal: string | null } | null;
  startedAt: number;
  endedAt: number;
  stopping?: NodeJS.Signals;
  waiters: Set<() => void>;
}

export interface StartAndWaitResult {
  id: string;
  finished: boolean;
  exitCode: number | null;
  signal: string | null;
  output: string;
}

export interface BackgroundTaskSummary {
  id: string;
  description: string;
  command: string;
  running: boolean;
  exitCode: number | null;
  signal: string | null;
}

export type Notify = (agentId: string, chatId: string, text: string) => void;

const escape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/**
 * The notice a finished task leaves in its chat, which the model reads as its next message and `extractHarnessEvents`
 * (core/harness.ts) shows as an event. `<summary>` is the task's description, or its trimmed command when it had none;
 * `<command>` is the whole command; `<result>` is the output's last 2000 characters. Each is entity-escaped.
 */
const taskNotification = (id: string, status: string, summary: string, command: string, tail: string) =>
  `<task-notification>\n<task-id>${id}</task-id>\n<status>${status}</status>\n<summary>${escape(summary)}</summary>\n<command>${escape(command)}</command>\n<result>${escape(tail)}</result>\n</task-notification>`;

const RESIGNAL_MS = 150;
const GRACE_MS = 2_000;
const WINDOWS_SHELL_MS = 1_000;
/**
 * After a stop, how long the task's output may stay open once its shell has gone. Something the stop could not reach
 * holds it then: on Windows, a Git Bash child that taskkill's tree misses (its emulated fork leaves it parentless).
 * The task's pipes are closed on our side, so it reads as stopped rather than running forever.
 */
const STRAGGLER_MS = 500;

export function shell(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  exists: (path: string) => boolean = existsSync,
): string {
  if (platform !== "win32") return env.SHELL || "/bin/sh";
  for (const root of [env.ProgramFiles, env["ProgramFiles(x86)"]]) {
    const bash = root ? join(root, "Git", "bin", "bash.exe") : null;
    if (bash && exists(bash)) return bash;
  }
  return "bash.exe";
}

export class BackgroundTasks {
  private readonly tasks = new Map<string, Task>();
  private readonly notify: Notify;

  constructor(notify: Notify) {
    this.notify = notify;
  }

  start(agentId: string, chatId: string, cwd: string, command: string, description = ""): string {
    this.prune();
    const id = `bg-${randomBytes(3).toString("hex")}`;
    // Outside (bash): it keeps `sleep 30`, a dev server under `npm run`, as children that hold the output open after the
    // shell itself is gone, so off Windows the task gets its own process group, and stopping it stops them too.
    const child = spawn(shell(), ["-c", command], { cwd, stdio: ["pipe", "pipe", "pipe"], env: process.env, detached: process.platform !== "win32" });
    const task: Task = {
      id,
      agentId,
      chatId,
      command,
      description,
      child,
      output: "",
      read: 0,
      exit: null,
      startedAt: Date.now(),
      endedAt: 0,
      waiters: new Set(),
    };
    const take = (text: string) => {
      if (!text) return;
      task.output += text;
      if (task.output.length > KEEP) {
        const cut = task.output.length - KEEP;
        task.output = task.output.slice(cut);
        task.read = Math.max(0, task.read - cut);
      }
      for (const w of task.waiters) w();
    };
    const stdoutDecoder = new StringDecoder("utf8");
    const stderrDecoder = new StringDecoder("utf8");
    child.stdout.on("data", (chunk: Buffer) => take(stdoutDecoder.write(chunk)));
    child.stderr.on("data", (chunk: Buffer) => take(stderrDecoder.write(chunk)));
    child.on("error", (error) => take(`\n${error.message}\n`));
    // Outside (Node): a write to a task whose input has closed is emitted as an EPIPE error, thrown when nobody listens.
    child.stdin.on("error", (error) => take(`\n[input: ${error.message}]\n`));
    child.on("exit", () => {
      if (!task.stopping) return;
      setTimeout(() => {
        if (task.exit) return;
        for (const stream of [child.stdin, child.stdout, child.stderr]) stream.destroy();
      }, STRAGGLER_MS).unref();
    });
    child.on("close", (code, exitSignal) => {
      // Outside (Windows): it ends a tree without a signal; a task stopped there still reads as stopped.
      const signal = exitSignal ?? task.stopping ?? null;
      take(stdoutDecoder.end() + stderrDecoder.end());
      task.exit = { code, signal };
      task.endedAt = Date.now();
      const watched = task.waiters.size > 0;
      for (const w of task.waiters) w();
      if (watched) return;
      const status = signal ? `stopped (${signal})` : code === 0 ? "completed" : `failed (exit ${code})`;
      const tail = task.output.slice(-2000).trim();
      this.notify(agentId, chatId, taskNotification(id, status, description || shellTitle(command), command, tail));
    });
    this.tasks.set(id, task);
    return id;
  }

  async startAndWait(
    agentId: string,
    chatId: string,
    cwd: string,
    command: string,
    description: string,
    waitMs: number,
    signal?: AbortSignal,
  ): Promise<StartAndWaitResult> {
    if (signal?.aborted) throw new Error("Command aborted.");
    const id = this.start(agentId, chatId, cwd, command, description);
    if (waitMs <= 0) return { id, finished: false, exitCode: null, signal: null, output: "" };
    const task = this.get(id, agentId);
    if (!task.exit) {
      await new Promise<void>((resolve) => {
        const finish = () => {
          clearTimeout(timer);
          task.waiters.delete(check);
          signal?.removeEventListener("abort", finish);
          resolve();
        };
        const check = () => {
          if (task.exit) finish();
        };
        const timer = setTimeout(finish, waitMs);
        task.waiters.add(check);
        signal?.addEventListener("abort", finish, { once: true });
      });
    }
    if (signal?.aborted && !task.exit) {
      this.kill(task);
      throw new Error("Command aborted.");
    }
    if (task.exit) {
      this.tasks.delete(id);
      return { id, finished: true, exitCode: task.exit.code, signal: task.exit.signal, output: task.output };
    }
    const output = task.output.slice(task.read);
    task.read = task.output.length;
    return { id, finished: false, exitCode: null, signal: null, output };
  }

  list(agentId: string): BackgroundTaskSummary[] {
    return [...this.tasks.values()]
      .filter((t) => t.agentId === agentId)
      .sort((a, b) => Number(Boolean(a.exit)) - Number(Boolean(b.exit)) || b.startedAt - a.startedAt)
      .map((t) => ({
        id: t.id,
        description: t.description,
        command: t.command,
        running: t.exit === null,
        exitCode: t.exit?.code ?? null,
        signal: t.exit?.signal ?? null,
      }));
  }

  private get(id: string, agentId: string): Task {
    const task = this.tasks.get(id);
    if (task?.agentId !== agentId) throw new Error(`no background task ${id} (tasks end when loki's daemon restarts)`);
    return task;
  }

  output(id: string, agentId: string): string {
    const task = this.get(id, agentId);
    const fresh = task.output.slice(task.read);
    task.read = task.output.length;
    const state = task.exit ? (task.exit.signal ? `stopped (${task.exit.signal})` : `exited with ${task.exit.code}`) : "running";
    return `[${state}]\n${fresh || "(no new output)"}`;
  }

  write(id: string, agentId: string, text: string): void {
    const task = this.get(id, agentId);
    if (task.exit || !task.child.stdin?.writable) throw new Error(`${id} is not running`);
    task.child.stdin.write(text);
  }

  stop(id: string, agentId: string): void {
    this.kill(this.get(id, agentId));
  }

  stopAgent(agentId: string): void {
    for (const task of this.tasks.values()) if (task.agentId === agentId) this.kill(task);
  }

  /**
   * End every running task at once, as the daemon exits: no grace, since nothing is left to wait for it, and nothing
   * asynchronous, since an exiting process runs no timers. A task that ignored the stop's SIGTERM, or one still running
   * when the daemon dies of an error, would otherwise live on holding its port.
   */
  killAll(): void {
    for (const task of this.tasks.values()) {
      const pid = task.child.pid;
      if (task.exit || pid === undefined) continue;
      task.stopping ??= "SIGKILL";
      try {
        if (process.platform === "win32") execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
        else process.kill(-pid, "SIGKILL");
      } catch {}
    }
  }

  /**
   * End a task and everything its shell started: its process group, or on Windows its process tree. Signalled again
   * shortly after, because a process the shell was forking as the first signal landed misses it and lives on holding
   * the output open (CI's busy runners hit this); whatever still runs after the grace period is killed outright.
   */
  private kill(task: Task): void {
    const pid = task.child.pid;
    if (task.exit || task.stopping || pid === undefined) return;
    task.stopping = "SIGTERM";
    const end = (force: boolean) => {
      if (task.exit) return;
      if (process.platform === "win32") {
        // Outside (Windows): taskkill ends the tree but can take a second or more on a busy machine, so the shell itself
        // is ended once it answers or after WINDOWS_SHELL_MS, whichever comes first.
        const shell = setTimeout(() => !task.exit && task.child.kill(), WINDOWS_SHELL_MS);
        shell.unref();
        execFile("taskkill", ["/PID", String(pid), "/T", "/F"], () => {
          clearTimeout(shell);
          if (!task.exit) task.child.kill();
        });
        return;
      }
      try {
        process.kill(-pid, force ? "SIGKILL" : "SIGTERM");
      } catch {
        if (!force) task.child.kill("SIGTERM");
      }
    };
    end(false);
    const timers = [setTimeout(() => end(false), RESIGNAL_MS), setTimeout(() => end(true), GRACE_MS)];
    for (const t of timers) t.unref();
    task.child.once("close", () => timers.forEach(clearTimeout));
  }

  private prune(now = Date.now()): void {
    const finished = [...this.tasks.values()].filter((t) => t.exit).sort((a, b) => b.endedAt - a.endedAt);
    finished.forEach((t, i) => {
      if (i >= KEEP_FINISHED || now - t.endedAt > KEEP_FINISHED_MS) this.tasks.delete(t.id);
    });
  }

  async wait(id: string, agentId: string, pattern: string | undefined, ms: number, signal?: AbortSignal): Promise<string> {
    const task = this.get(id, agentId);
    const re = pattern ? new RegExp(pattern) : null;
    const done = () => Boolean(task.exit) || (re?.test(task.output.slice(task.read)) ?? false);
    if (!done()) {
      await new Promise<void>((resolve) => {
        const finish = () => {
          clearTimeout(timer);
          task.waiters.delete(check);
          signal?.removeEventListener("abort", finish);
          resolve();
        };
        const check = () => done() && finish();
        const timer = setTimeout(finish, ms);
        task.waiters.add(check);
        signal?.addEventListener("abort", finish, { once: true });
      });
    }
    return this.output(id, agentId);
  }

  stopAll(): void {
    for (const task of this.tasks.values()) this.kill(task);
  }
}

async function caller(api: ToolExecutionApi, context: Context) {
  const [agent, chat, resolved] = await Promise.all([
    api.snapshot(AgentInfoDoc, context),
    api.snapshot(ChatDoc, api.conversationId, context),
    api.agent(context),
  ]);
  return { agentId: agent?.id ?? "", chatId: chat?.id || `conversation-${api.conversationId}`, cwd: resolved.cwd ?? process.cwd() };
}

const text = (t: string) => ({ output: [{ type: "text" as const, text: t }] });

const STOP_WAIT_MS = GRACE_MS + 1_000;

export function wrapBashWithBackground(bash: ToolRegistration, tasks: BackgroundTasks): ToolRegistration {
  const schema = isRecord(bash.parameters) ? bash.parameters : {};
  const properties = isRecord(schema.properties) ? schema.properties : {};
  return {
    ...bash,
    description: `${bash.description} Set wait_ms to auto-background after waiting, or background: true to run in background (manage with background_watch).`,
    parameters: {
      ...schema,
      properties: {
        ...properties,
        background: { type: "boolean" },
        wait_ms: { type: "number" },
      },
    },
    execute: async (rawArgs, api, context) => {
      const { description, background, wait_ms, ...rest } = isRecord(rawArgs) ? rawArgs : {};
      if (background === true || (typeof wait_ms === "number" && Number.isFinite(wait_ms))) {
        const waitMs = background === true ? 0 : Math.min(Math.max(Number(wait_ms) || 0, 0), MAX_WAIT_MS);
        const command = typeof rest.command === "string" ? rest.command : "";
        const { agentId, chatId, cwd } = await caller(api, context);
        const res = await tasks.startAndWait(agentId, chatId, cwd, command, typeof description === "string" ? description : "", waitMs, context.abortSignal);
        if (res.finished) {
          if (res.exitCode !== 0 || res.signal) {
            const detail = res.output.trimEnd();
            const status = res.signal ? `signal ${res.signal}` : `code ${res.exitCode ?? 1}`;
            throw new Error(`${detail ? `${detail}\n\n` : ""}Command exited with ${status}`);
          }
          return text(res.output || "(no output)");
        }
        if (waitMs === 0 && !res.output) return text(`started background task ${res.id}`);
        return text(
          `Command still running in background as task ${res.id} (you will be notified when it finishes; use background_watch to check output, send input, or stop it).${res.output ? `\n\nOutput so far:\n${res.output}` : ""}`,
        );
      }
      return bash.execute(rest, api, context);
    },
  };
}

function formatTaskList(list: readonly BackgroundTaskSummary[]): string {
  if (!list.length) return "No background tasks.";
  return list
    .map((t) => {
      const state = t.running ? "running" : t.signal ? `stopped (${t.signal})` : `exited with ${t.exitCode}`;
      const label = t.description || shellTitle(t.command);
      return `${t.id} [${state}] ${label}`;
    })
    .join("\n");
}

export function backgroundExtension(tasks: BackgroundTasks): Extension {
  return defineExtension({
    name: "loki.background",
    tools: [
      withKind(
        "read",
        withStepDescription(
          defineTool({
            name: "background_watch",
            description:
              "List background tasks (no task_id), or wait for output matching pattern, exit, or timeout_ms (default 30000; 0 reads now); input writes stdin, stop: true stops.",
            parameters: {
              type: "object",
              properties: {
                task_id: { type: "string" },
                pattern: { type: "string" },
                timeout_ms: { type: "number" },
                input: { type: "string" },
                stop: { type: "boolean" },
              },
              required: [],
            } as never,
            execute: async (args, api, context) => {
              const a = args as { task_id?: string; pattern?: string; timeout_ms?: number; input?: string; stop?: boolean };
              const { agentId } = await caller(api, context);
              const taskId = typeof a.task_id === "string" ? a.task_id.trim() : "";
              if (!taskId) {
                if (a.input !== undefined || a.stop === true) throw new Error("task_id is required when sending input or stopping a task");
                return text(formatTaskList(tasks.list(agentId)));
              }
              if (a.input !== undefined) tasks.write(taskId, agentId, a.input);
              if (a.stop) tasks.stop(taskId, agentId);
              const ms = a.stop ? STOP_WAIT_MS : Math.min(Math.max(a.timeout_ms ?? 30_000, 0), MAX_WAIT_MS);
              return text(await tasks.wait(taskId, agentId, a.stop ? undefined : a.pattern, ms, context.abortSignal));
            },
          }),
        ),
      ),
    ],
  });
}
