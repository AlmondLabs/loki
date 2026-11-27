import { copyJson, type Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT, withAbortSignal, withoutAbortSignal } from "@earendil-works/chord/context";
import {
  AgentDoc as PiAgentDoc,
  configure,
  defineExtension,
  defineTool,
  type Conversation,
  type ConversationId,
  type Cursor,
  type Extension,
  type Harness,
  type ToolExecutionApi,
} from "@earendil-works/pi-durable";
import { isAbsolute, resolve } from "node:path";
import { messageOf } from "../core/errors.ts";
import { unansweredWhy } from "./chat-events.ts";
import { AgentInfoDoc, ChatDoc } from "./kernel/index.ts";
import { withStepDescription } from "./step-description.ts";
import { withKind } from "./tool-kinds.ts";
import { defaultWorktreeOps, type WorktreeInfo, type WorktreeOps } from "./worktrees.ts";

const MAX_WAIT_MS = 600_000;
const KEEP_FINISHED_MS = 60 * 60_000;
const KEEP_FINISHED = 32;
const RESULT_CAP = 16 * 1024;

export type SubagentStatus = "running" | "done" | "error" | "stopped";

export type SubagentNotify = (agentId: string, chatId: string, text: string) => void | Promise<void>;

export interface SubagentManagerOptions {
  notify?: SubagentNotify;
  harnessFor?: (agentId: string) => Promise<Harness>;
  context?: Context;
  worktreesDir?: string;
  worktreeOps?: WorktreeOps;
  now?: () => number;
}

export interface SubagentRun {
  readonly id: string;
  readonly agentId: string;
  readonly chatId: string;
  readonly conversationId: ConversationId;
  conversation?: Conversation;
  description: string;
  readonly cwd?: string;
  worktree: WorktreeInfo | null;
  status: SubagentStatus;
  output: string;
  startedAt: number;
  endedAt: number;
  abort: AbortController;
  donePromise?: Promise<void>;
  readonly waiters: Set<() => void>;
}

const escapeXml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function subagentNotification(run: SubagentRun): string {
  const status = run.status === "done" ? "completed" : run.status === "stopped" ? "stopped" : "failed";
  const summary = run.description || "Helper task";
  const header = run.worktree ? `[worktree: ${run.worktree.path} | branch: ${run.worktree.branch}]\n\n` : "";
  const full = `${header}${run.output}`.trim();
  const body = full.length > RESULT_CAP ? full.slice(0, RESULT_CAP) : full;
  return [
    "<task-notification>",
    "<kind>subagent</kind>",
    `<task-id>${run.id}</task-id>`,
    `<status>${status}</status>`,
    `<summary>${escapeXml(summary)}</summary>`,
    `<result>${escapeXml(body)}</result>`,
    "</task-notification>",
  ].join("\n");
}

function formatRunResult(run: SubagentRun): string {
  const meta = [`subagent ${run.id}`, `status: ${run.status}`];
  if (run.worktree) {
    meta.push(`branch: ${run.worktree.branch}`, `worktree: ${run.worktree.path}`);
  }
  const head = `[${meta.join(" | ")}]`;
  return run.output ? `${head}\n${run.output}` : head;
}

function formatSyncFooter(run: SubagentRun, answer: string): string {
  const text = answer || "The helper finished without an answer.";
  if (!run.worktree) return text;
  return `${text}\n\n[subagent ${run.id} | branch: ${run.worktree.branch} | worktree: ${run.worktree.path}]`;
}

export class SubagentManager {
  private readonly runs = new Map<string, SubagentRun>();
  private seq = 0;
  private readonly notify: SubagentNotify | undefined;
  private readonly getHarness: ((agentId: string) => Promise<Harness>) | undefined;
  readonly context: Context;
  private readonly worktreeOps: WorktreeOps | undefined;
  private readonly now: () => number;

  constructor(options: SubagentManagerOptions = {}) {
    this.notify = options.notify;
    this.getHarness = options.harnessFor;
    this.context = options.context ?? BACKGROUND_CONTEXT;
    this.worktreeOps = options.worktreeOps ?? (options.worktreesDir ? defaultWorktreeOps(options.worktreesDir) : undefined);
    this.now = options.now ?? (() => Date.now());
  }

  hasHarness(): boolean {
    return this.getHarness !== undefined;
  }

  async harnessFor(agentId: string): Promise<Harness> {
    if (!this.getHarness) throw new Error("Async subagents are not enabled in this runtime.");
    return this.getHarness(agentId);
  }

  nextId(): string {
    this.seq += 1;
    return `sub-${this.seq}`;
  }

  async createWorktree(id: string, baseCwd: string): Promise<WorktreeInfo> {
    if (!this.worktreeOps) throw new Error("Git worktrees are not configured in this runtime.");
    return this.worktreeOps.create(baseCwd, id);
  }

  async removeWorktree(info: WorktreeInfo): Promise<void> {
    if (!this.worktreeOps) return;
    await this.worktreeOps.remove(info);
  }

  register(run: SubagentRun): void {
    this.prune();
    this.runs.set(run.id, run);
  }

  get(id: string, agentId: string): SubagentRun {
    const run = this.runs.get(id);
    if (run?.agentId !== agentId) throw new Error(`no subagent ${id} (subagents end when loki's daemon restarts)`);
    return run;
  }

  list(agentId: string): string {
    const mine = [...this.runs.values()]
      .filter((r) => r.agentId === agentId)
      .sort((a, b) => Number(a.status !== "running") - Number(b.status !== "running") || b.startedAt - a.startedAt);
    if (!mine.length) return "No subagents.";
    return mine
      .map((r) => {
        const wt = r.worktree ? ` (branch ${r.worktree.branch})` : "";
        return `${r.id} [${r.status}]${wt} ${r.description || "Helper task"}`;
      })
      .join("\n");
  }

  launchAsync(run: SubagentRun, execute: () => Promise<string>): void {
    run.donePromise = (async () => {
      try {
        const answer = await execute();
        if (run.status === "running") {
          run.status = "done";
          run.output = answer;
          run.endedAt = this.now();
        }
      } catch (error) {
        if (run.status === "running") {
          run.status = "error";
          run.output = messageOf(error);
          run.endedAt = this.now();
        }
      } finally {
        const watched = run.waiters.size > 0;
        for (const wake of run.waiters) wake();
        if (!watched && run.status !== "stopped" && this.notify) {
          void Promise.resolve(this.notify(run.agentId, run.chatId, subagentNotification(run))).catch(() => {});
        }
      }
    })();
  }

  async wait(id: string, agentId: string, ms: number, signal?: AbortSignal): Promise<string> {
    const run = this.get(id, agentId);
    if (run.status === "running" && ms > 0) {
      await new Promise<void>((resolveWait) => {
        const finish = () => {
          clearTimeout(timer);
          run.waiters.delete(check);
          signal?.removeEventListener("abort", finish);
          resolveWait();
        };
        const check = () => {
          if (run.status !== "running") finish();
        };
        const timer = setTimeout(finish, ms);
        run.waiters.add(check);
        signal?.addEventListener("abort", finish, { once: true });
      });
    }
    return formatRunResult(run);
  }

  async stop(id: string, agentId: string, removeWorktree = true): Promise<string> {
    const run = this.get(id, agentId);
    const wasRunning = run.status === "running";
    if (wasRunning) {
      run.status = "stopped";
      run.endedAt = this.now();
    }
    run.abort.abort();
    if (run.conversation && wasRunning) {
      await run.conversation.abort(withoutAbortSignal(this.context)).catch(() => {});
    }
    if (run.donePromise) await run.donePromise.catch(() => {});
    for (const wake of run.waiters) wake();
    let worktreeNote = "";
    if (run.worktree) {
      if (removeWorktree) {
        await this.removeWorktree(run.worktree);
        worktreeNote = `; removed worktree ${run.worktree.path}`;
        run.worktree = null;
      } else {
        worktreeNote = `; kept worktree ${run.worktree.path}`;
      }
    }
    return `${wasRunning ? `Stopped subagent ${id}` : `Subagent ${id} already ${run.status}`}${worktreeNote}.`;
  }

  async stopAgent(agentId: string): Promise<void> {
    const mine = [...this.runs.values()].filter((r) => r.agentId === agentId);
    await Promise.all(mine.map((r) => this.stop(r.id, agentId, true)));
  }

  async stopAll(): Promise<void> {
    const all = [...this.runs.values()];
    await Promise.all(all.map((r) => this.stop(r.id, r.agentId, true)));
  }

  private prune(now = this.now()): void {
    const finished = [...this.runs.values()].filter((r) => r.status !== "running" && r.worktree === null).sort((a, b) => b.endedAt - a.endedAt);
    finished.forEach((r, i) => {
      if (i >= KEEP_FINISHED || now - r.endedAt > KEEP_FINISHED_MS) this.runs.delete(r.id);
    });
  }
}

function assistantText(entry: { kind: string; model?: unknown }): string {
  if (entry.kind !== "pi.assistant" || !Array.isArray(entry.model)) return "";
  const m = entry.model[0] as { role?: string; content?: Array<{ type?: string; text?: string }> } | undefined;
  if (m?.role !== "assistant") return "";
  return (m.content ?? [])
    .filter((p) => p.type === "text")
    .map((p) => p.text)
    .join("")
    .trim();
}

async function lastAssistantText(api: ToolExecutionApi, conversationId: ConversationId, context: Context, cursor?: Cursor): Promise<string> {
  const page = await api.commit((tx) => tx.scanEntries({ conversationId, order: "descending" }, 50, cursor), context);
  for (const entry of page.items) {
    const text = assistantText(entry);
    if (text) return text;
  }
  return page.next === undefined ? "" : lastAssistantText(api, conversationId, context, page.next);
}

async function lastAssistantTextFromConversation(conv: Conversation, context: Context, cursor?: Cursor): Promise<string> {
  const page = await conv.entries({ order: "descending" }, 50, cursor, context);
  for (const entry of page.items) {
    const text = assistantText(entry);
    if (text) return text;
  }
  return page.next === undefined ? "" : lastAssistantTextFromConversation(conv, context, page.next);
}

async function callerInfo(api: ToolExecutionApi, context: Context) {
  const [agentInfo, chatInfo, parentAgent] = await Promise.all([
    api.snapshot(AgentInfoDoc, context),
    api.snapshot(ChatDoc, api.conversationId, context),
    api.agent(context),
  ]);
  return {
    agentId: agentInfo?.id ?? "",
    chatId: chatInfo?.id || `conversation-${api.conversationId}`,
    parentChatDocId: chatInfo?.id ?? "",
    baseCwd: parentAgent.cwd ?? process.cwd(),
  };
}

function resolveOptionalCwd(rawCwd: string | undefined, baseCwd: string): string | undefined {
  if (typeof rawCwd !== "string" || !rawCwd.trim()) return undefined;
  const trimmed = rawCwd.trim();
  return isAbsolute(trimmed) ? trimmed : resolve(baseCwd, trimmed);
}

const textOut = (text: string) => ({ output: [{ type: "text" as const, text }] });

interface SubagentArgs {
  prompt: string;
  cwd?: string;
  workspace?: "inherit" | "worktree";
  async?: boolean;
  subagent_id?: string;
  description?: string;
}

export function subagentExtension(manager: SubagentManager = new SubagentManager(), withoutAlso: readonly Extension[] = []): Extension {
  const extension: Extension = defineExtension({
    name: "loki.subagents",
    tools: [
      withKind(
        "read",
        withStepDescription(
          defineTool({
            name: "subagent",
            description:
              "Delegate a self-contained task to a helper agent (it does not see this chat). Optional: cwd, workspace ('inherit'|'worktree'), async: true (notifies when done), subagent_id (continue a finished helper).",
            parameters: {
              type: "object",
              properties: {
                prompt: { type: "string" },
                cwd: { type: "string" },
                workspace: { type: "string", enum: ["inherit", "worktree"] },
                async: { type: "boolean" },
                subagent_id: { type: "string" },
              },
              required: ["prompt"],
            } as never,
            replay: "safe",
            execute: async (rawArgs, api, context) => {
              const args = rawArgs as SubagentArgs;
              const { agentId, chatId, parentChatDocId, baseCwd } = await callerInfo(api, context);
              const description = typeof args.description === "string" ? args.description : "";

              let run: SubagentRun;
              if (args.subagent_id) {
                if (args.cwd !== undefined || args.workspace === "worktree") {
                  throw new Error("cwd and workspace cannot be changed when continuing an existing subagent_id");
                }
                const existing = manager.get(args.subagent_id, agentId);
                if (existing.status === "running") throw new Error(`subagent ${args.subagent_id} is still running`);
                if (existing.status === "stopped") throw new Error(`subagent ${args.subagent_id} was stopped`);
                existing.status = "running";
                existing.output = "";
                existing.endedAt = 0;
                existing.abort = new AbortController();
                if (description) existing.description = description;
                run = existing;
              } else {
                const requestedCwd = resolveOptionalCwd(args.cwd, baseCwd);
                const id = manager.nextId();
                const worktree = args.workspace === "worktree" ? await manager.createWorktree(id, requestedCwd ?? baseCwd) : null;
                const effectiveCwd = worktree?.cwd ?? requestedCwd;
                try {
                  let conversationId: ConversationId;
                  let conversation: Conversation | undefined;
                  if (manager.hasHarness()) {
                    const harness = await manager.harnessFor(agentId);
                    const parentAgentState = await api.snapshot(PiAgentDoc, api.conversationId, context);
                    conversation = await harness.createConversation(
                      {
                        ownership: { kind: "ownerless" },
                        init: async (tx, childId) => {
                          if (parentAgentState) Object.assign(await tx.doc(PiAgentDoc, childId), copyJson(parentAgentState));
                          await configure(tx, childId, {
                            ...(effectiveCwd ? { cwd: effectiveCwd } : {}),
                            extensions: { remove: [extension, ...withoutAlso] },
                          });
                          const info = await tx.doc(ChatDoc, childId);
                          Object.assign(info, { id: parentChatDocId, hidden: true, helper_for: api.conversationId });
                        },
                      },
                      context,
                    );
                    conversationId = conversation.id;
                  } else {
                    conversationId = await api.commit(async (tx) => {
                      const existing = (await tx.scanConversations({ ownerTaskId: api.taskId }, 1)).items.at(0);
                      if (existing) return existing.id;
                      const created = await tx.createConversation({ ownership: { kind: "task", taskId: api.taskId } });
                      await configure(tx, created.id, {
                        ...(effectiveCwd ? { cwd: effectiveCwd } : {}),
                        extensions: { remove: [extension, ...withoutAlso] },
                      });
                      const info = await tx.doc(ChatDoc, created.id);
                      Object.assign(info, { id: parentChatDocId, hidden: true, helper_for: api.conversationId });
                      return created.id;
                    }, context);
                  }
                  run = {
                    id,
                    agentId,
                    chatId,
                    conversationId,
                    ...(conversation ? { conversation } : {}),
                    description,
                    ...(effectiveCwd ? { cwd: effectiveCwd } : {}),
                    worktree,
                    status: "running",
                    output: "",
                    startedAt: Date.now(),
                    endedAt: 0,
                    abort: new AbortController(),
                    waiters: new Set(),
                  };
                  manager.register(run);
                } catch (error) {
                  if (worktree) await manager.removeWorktree(worktree);
                  throw error;
                }
              }

              await api.details({ conversationId: run.conversationId }, context);

              if (args.async) {
                if (!manager.hasHarness()) throw new Error("Async subagents are not enabled in this runtime.");
                const harness = await manager.harnessFor(agentId);
                const conv = run.conversation ?? (await harness.conversation(run.conversationId, context));
                if (!conv) throw new Error("the helper's conversation is gone");
                run.conversation = conv;
                const childContext = withAbortSignal(run.abort.signal, withoutAbortSignal(manager.context));
                const requestId = `subagent:${api.taskId}`;
                manager.launchAsync(run, async () => {
                  const settled = await (await conv.submit({ type: "input", content: args.prompt, requestId }, childContext)).wait(childContext);
                  if (settled.status !== "done") throw new Error(`the helper did not finish: ${unansweredWhy(settled)}`);
                  return (await lastAssistantTextFromConversation(conv, childContext)) || "The helper finished without an answer.";
                });
                const wt = run.worktree ? ` in worktree ${run.worktree.path} (branch ${run.worktree.branch})` : "";
                return textOut(`started subagent ${run.id}${wt}. You will be notified when it finishes, or check with subagent_status.`);
              }

              const onAbort = () => {
                if (run.status === "running") run.status = "stopped";
                run.abort.abort();
                if (run.conversation) void run.conversation.abort(withoutAbortSignal(manager.context)).catch(() => {});
              };
              context.abortSignal?.addEventListener("abort", onAbort, { once: true });
              const childContext = withAbortSignal(run.abort.signal, context);
              try {
                let answer: string;
                if (run.conversation) {
                  const settled = await (
                    await run.conversation.submit({ type: "input", content: args.prompt, requestId: `subagent:${api.taskId}` }, childContext)
                  ).wait(childContext);
                  if (settled.status !== "done") throw new Error(`the helper did not finish: ${unansweredWhy(settled)}`);
                  answer = await lastAssistantTextFromConversation(run.conversation, childContext);
                } else {
                  const handle = await api.conversation(run.conversationId, context);
                  if (!handle) throw new Error("the helper's conversation is gone");
                  const settled = await (
                    await handle.submit({ type: "input", content: args.prompt, requestId: `subagent:${api.taskId}` }, childContext)
                  ).wait(childContext);
                  if (settled.status !== "done") throw new Error(`the helper did not finish: ${unansweredWhy(settled)}`);
                  answer = await lastAssistantText(api, run.conversationId, childContext);
                }
                if (run.status === "running") {
                  run.status = "done";
                  run.output = answer || "The helper finished without an answer.";
                  run.endedAt = Date.now();
                }
                return textOut(formatSyncFooter(run, answer));
              } catch (error) {
                if (run.status === "running") {
                  run.status = "error";
                  run.output = messageOf(error);
                  run.endedAt = Date.now();
                }
                throw error;
              } finally {
                context.abortSignal?.removeEventListener("abort", onAbort);
              }
            },
          }),
        ),
      ),
      withKind(
        "read",
        withStepDescription(
          defineTool({
            name: "subagent_status",
            description: "List subagents (no subagent_id), or check/wait up to wait_ms (default 0) for one.",
            parameters: {
              type: "object",
              properties: {
                subagent_id: { type: "string" },
                wait_ms: { type: "number" },
              },
              required: [],
            } as never,
            replay: "safe",
            execute: async (rawArgs, api, context) => {
              const args = rawArgs as { subagent_id?: string; wait_ms?: number };
              const { agentId } = await callerInfo(api, context);
              const id = typeof args.subagent_id === "string" ? args.subagent_id.trim() : "";
              if (!id) return textOut(manager.list(agentId));
              const waitMs = typeof args.wait_ms === "number" && Number.isFinite(args.wait_ms) ? Math.min(Math.max(args.wait_ms, 0), MAX_WAIT_MS) : 0;
              return textOut(await manager.wait(id, agentId, waitMs, context.abortSignal));
            },
          }),
        ),
      ),
      withKind(
        "command",
        withStepDescription(
          defineTool({
            name: "subagent_stop",
            description: "Stop a subagent and remove its worktree unless remove_worktree is false.",
            parameters: {
              type: "object",
              properties: {
                subagent_id: { type: "string" },
                remove_worktree: { type: "boolean" },
              },
              required: ["subagent_id"],
            } as never,
            execute: async (rawArgs, api, context) => {
              const args = rawArgs as { subagent_id: string; remove_worktree?: boolean };
              const { agentId } = await callerInfo(api, context);
              return textOut(await manager.stop(args.subagent_id, agentId, args.remove_worktree ?? true));
            },
          }),
        ),
      ),
    ],
  });
  return extension;
}
