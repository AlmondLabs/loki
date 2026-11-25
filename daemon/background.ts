import type { Context } from "@earendil-works/chord";
import { defineExtension, defineTool, type Extension, type ToolExecutionApi } from "@earendil-works/pi-durable";
import { execFile, execFileSync, spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { AgentInfoDoc, ChatDoc } from "./kernel/index.ts";
import { shellTitle } from "../core/shell-title.ts";
import { withStepDescription } from "./step-description.ts";
import { withKind } from "./tool-kinds.ts";

const KEEP = 256 * 1024;
const KEEP_FINISHED_MS = 60 * 60_000;
const KEEP_FINISHED = 32;

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
  endedAt: number;
  stopping?: NodeJS.Signals;
  waiters: Set<() => void>;
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
    const task: Task = { id, agentId, chatId, command, description, child, output: "", read: 0, exit: null, endedAt: 0, waiters: new Set() };
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
const idParam = { task_id: { type: "string" } };

const STOP_WAIT_MS = GRACE_MS + 1_000;

export function backgroundExtension(tasks: BackgroundTasks): Extension {
  return defineExtension({
    name: "loki.background",
    tools: [
      withKind(
        "command",
        withStepDescription(
          defineTool({
            name: "background_run",
            description:
              "Start a shell command that keeps running in the background (a server, a long build, a watcher). You get its task id; you are told when it ends.",
            parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } as never,
            execute: async (args, api, context) => {
              const { command, description } = args as { command: string; description: string };
              const { agentId, chatId, cwd } = await caller(api, context);
              const id = tasks.start(agentId, chatId, cwd, command, description);
              return text(`started background task ${id}`);
            },
          }),
        ),
      ),
      withKind(
        "read",
        withStepDescription(
          defineTool({
            name: "background_watch",
            description:
              "A background task's output since you last read it, and whether it is still running. It waits first: until the output matches `pattern` (a regular expression), the task ends, or `timeout_ms` runs out (default 30000; 0 reads at once). `input` is written to the task's input before the wait (add \\n to end a line); `stop: true` stops the task and waits for it to end.",
            parameters: {
              type: "object",
              properties: { ...idParam, pattern: { type: "string" }, timeout_ms: { type: "number" }, input: { type: "string" }, stop: { type: "boolean" } },
              required: ["task_id"],
            } as never,
            execute: async (args, api, context) => {
              const a = args as { task_id: string; pattern?: string; timeout_ms?: number; input?: string; stop?: boolean };
              const { agentId } = await caller(api, context);
              if (a.input !== undefined) tasks.write(a.task_id, agentId, a.input);
              if (a.stop) tasks.stop(a.task_id, agentId);
              const ms = a.stop ? STOP_WAIT_MS : Math.min(Math.max(a.timeout_ms ?? 30_000, 0), 600_000);
              return text(await tasks.wait(a.task_id, agentId, a.stop ? undefined : a.pattern, ms, context.abortSignal));
            },
          }),
        ),
      ),
    ],
  });
}
