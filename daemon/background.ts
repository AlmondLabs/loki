import type { Context } from "@earendil-works/chord";
import { defineExtension, defineTool, type Extension, type ToolExecutionApi } from "@earendil-works/pi-durable";
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { AgentInfoDoc, ChatDoc } from "./kernel/index.ts";

/**
 * Background tasks (plan 017, U11, KTD13): a shell command that keeps running after the turn that started it. The
 * agent reads its output so far, writes to its input, waits on it, or stops it; when it ends, its chat gets a
 * `<task-notification>` (the format the thread shows as an event row, core/harness.ts), which starts the agent's next
 * turn. The processes are the daemon's: they end with it, and a task from before a restart is gone.
 */

/** The most output a task keeps, from its end. */
const KEEP = 256 * 1024;

type Task = {
  id: string;
  agentId: string;
  chatId: string;
  command: string;
  child: ChildProcess;
  output: string;
  /** How much of the output the agent has read. */
  read: number;
  exit: { code: number | null; signal: string | null } | null;
  waiters: Set<() => void>;
};

export type Notify = (agentId: string, chatId: string, text: string) => void;

const escape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export class BackgroundTasks {
  private readonly tasks = new Map<string, Task>();
  private readonly notify: Notify;

  constructor(notify: Notify) {
    this.notify = notify;
  }

  start(agentId: string, chatId: string, cwd: string, command: string): string {
    const id = `bg-${randomBytes(3).toString("hex")}`;
    const child = spawn(process.env.SHELL || "/bin/sh", ["-c", command], { cwd, stdio: ["pipe", "pipe", "pipe"], env: process.env });
    const task: Task = { id, agentId, chatId, command, child, output: "", read: 0, exit: null, waiters: new Set() };
    const take = (chunk: Buffer) => {
      task.output += chunk.toString("utf8");
      if (task.output.length > KEEP) {
        const cut = task.output.length - KEEP;
        task.output = task.output.slice(cut);
        task.read = Math.max(0, task.read - cut);
      }
      for (const w of task.waiters) w();
    };
    child.stdout?.on("data", take);
    child.stderr?.on("data", take);
    child.on("error", (error) => take(Buffer.from(`\n${error.message}\n`)));
    child.on("close", (code, signal) => {
      task.exit = { code, signal };
      for (const w of task.waiters) w();
      const status = signal ? `stopped (${signal})` : code === 0 ? "completed" : `failed (exit ${code})`;
      const tail = task.output.slice(-2000).trim();
      this.notify(agentId, chatId, `<task-notification>\n<task-id>${id}</task-id>\n<status>${status}</status>\n<summary>${escape(command)}</summary>\n<result>${escape(tail)}</result>\n</task-notification>`);
    });
    this.tasks.set(id, task);
    return id;
  }

  private get(id: string, agentId: string): Task {
    const task = this.tasks.get(id);
    if (!task || task.agentId !== agentId) throw new Error(`no background task ${id} (tasks end when loki's daemon restarts)`);
    return task;
  }

  /** Output since the agent last read, and whether the task is still running. */
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
    const task = this.get(id, agentId);
    if (!task.exit) task.child.kill("SIGTERM");
  }

  /** Wait until the output matches `pattern`, the task ends, or `ms` pass; then its new output. */
  async wait(id: string, agentId: string, pattern: string | undefined, ms: number, signal?: AbortSignal): Promise<string> {
    const task = this.get(id, agentId);
    const re = pattern ? new RegExp(pattern) : null;
    const done = () => Boolean(task.exit) || (re !== null && re.test(task.output.slice(task.read)));
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

  /** End every task (the daemon is stopping). */
  stopAll(): void {
    for (const task of this.tasks.values()) if (!task.exit) task.child.kill("SIGTERM");
  }
}

async function caller(api: ToolExecutionApi, context: Context) {
  const [agent, chat, resolved] = await Promise.all([api.snapshot(AgentInfoDoc, context), api.snapshot(ChatDoc, api.conversationId, context), api.agent(context)]);
  return { agentId: agent?.id ?? "", chatId: chat?.id || `conversation-${api.conversationId}`, cwd: resolved.cwd ?? process.cwd() };
}

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });
const idParam = { task_id: { type: "string" } };

export function backgroundExtension(tasks: BackgroundTasks): Extension {
  return defineExtension({
    name: "loki.background",
    tools: [
      defineTool({
        name: "bash_background",
        description: "Start a shell command that keeps running in the background (a server, a long build, a watcher). You get its task id; you are told when it ends.",
        parameters: { type: "object", properties: { command: { type: "string" }, description: { type: "string" } }, required: ["command"] } as never,
        execute: async (args, api, context) => {
          const { agentId, chatId, cwd } = await caller(api, context);
          const id = tasks.start(agentId, chatId, cwd, (args as { command: string }).command);
          return text(`started background task ${id}`);
        },
      }),
      defineTool({
        name: "TaskOutput",
        description: "A background task's output since you last read it, and whether it is still running.",
        parameters: { type: "object", properties: idParam, required: ["task_id"] } as never,
        execute: async (args, api, context) => text(tasks.output((args as { task_id: string }).task_id, (await caller(api, context)).agentId)),
      }),
      defineTool({
        name: "write_stdin",
        description: "Write to a running background task's input (add \\n to end a line).",
        parameters: { type: "object", properties: { ...idParam, text: { type: "string" } }, required: ["task_id", "text"] } as never,
        execute: async (args, api, context) => {
          const a = args as { task_id: string; text: string };
          tasks.write(a.task_id, (await caller(api, context)).agentId, a.text);
          return text("written");
        },
      }),
      defineTool({
        name: "Monitor",
        description: "Wait for a background task: until its output matches a pattern (a regular expression), it ends, or the time runs out.",
        parameters: { type: "object", properties: { ...idParam, pattern: { type: "string" }, timeout_ms: { type: "number" } }, required: ["task_id"] } as never,
        execute: async (args, api, context) => {
          const a = args as { task_id: string; pattern?: string; timeout_ms?: number };
          return text(await tasks.wait(a.task_id, (await caller(api, context)).agentId, a.pattern, Math.min(Math.max(a.timeout_ms ?? 30_000, 0), 600_000), context.abortSignal));
        },
      }),
      defineTool({
        name: "TaskStop",
        description: "Stop a background task.",
        parameters: { type: "object", properties: idParam, required: ["task_id"] } as never,
        execute: async (args, api, context) => {
          tasks.stop((args as { task_id: string }).task_id, (await caller(api, context)).agentId);
          return text("stopping");
        },
      }),
    ],
  });
}
