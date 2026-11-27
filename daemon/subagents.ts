import { BACKGROUND_CONTEXT, withAbortSignal, withoutAbortSignal, type Context } from "@earendil-works/chord/context";
import { copyJson } from "@earendil-works/chord/json";
import { getSupportedThinkingLevels, type Api, type Model } from "@earendil-works/pi-ai";
import {
  AgentDoc as PiAgentDoc,
  configure,
  defineExtension,
  defineTool,
  type Agent,
  type Conversation,
  type ConversationId,
  type Cursor,
  type Extension,
  type ModelRef,
  type ToolExecutionApi,
  type ToolRegistration,
} from "@earendil-works/pi-durable";
import { isAbsolute, resolve } from "node:path";
import { messageOf } from "../core/errors.ts";
import { Listeners } from "../core/listeners.ts";
import { isReasoningEffort, type ReasoningEffort } from "../core/models.ts";
import { pickSubagentName, subagentChatId, subagentDisplayName, subagentIdOfChat, type SubagentStatus, type SubagentView } from "../core/subagents.ts";
import { unansweredWhy } from "./chat-events.ts";
import { AgentInfoDoc, ChatDoc, ChatIndex, READ_ONLY_EXTENSION, type AgentStore, type SubagentMeta } from "./kernel/index.ts";
import { modelRef, thinkingLevel } from "./loki-engine.ts";
import { READ_ONLY_TOOLS } from "./read-only-gate.ts";
import { withStepDescription } from "./step-description.ts";
import { withKind } from "./tool-kinds.ts";
import { defaultWorktreeOps, type WorktreeInfo, type WorktreeOps } from "./worktrees.ts";

const MAX_WAIT_MS = 600_000;
const KEEP_FINISHED_MS = 60 * 60_000;
const KEEP_FINISHED = 32;
const RESULT_CAP = 16 * 1024;
const FAST_HINT = /mini|flash|haiku|small|lite|nano|fast/i;
const STRONG_HINT = /opus|pro|sonnet|gpt-5|o3|o1/i;

export type SubagentNotify = (agentId: string, chatId: string, text: string) => void | Promise<void>;

export interface SubagentManagerOptions {
  notify?: SubagentNotify;
  storeFor?: (agentId: string) => Promise<AgentStore>;
  context?: Context;
  worktreesDir?: string;
  worktreeOps?: WorktreeOps;
  now?: () => number;
  pickName?: (used: ReadonlySet<string>) => string;
}

export interface SubagentRun {
  readonly id: string;
  readonly name: string;
  readonly agentId: string;
  readonly chatId: string;
  readonly subagentChatId?: string;
  readonly conversationId: ConversationId;
  conversation?: Conversation;
  description: string;
  model: string | null;
  readonly readOnly: boolean;
  readonly cwd?: string;
  worktree: WorktreeInfo | null;
  status: SubagentStatus;
  output: string;
  error: string | null;
  readonly startedAt: number;
  readonly startedAtIso: string;
  endedAt: number;
  abort: AbortController;
  donePromise?: Promise<void>;
  readonly waiters: Set<() => void>;
}

const escapeXml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function viewOfRun(run: SubagentRun): SubagentView {
  return {
    id: run.id,
    chat_id: run.subagentChatId ?? subagentChatId(run.chatId, run.id),
    name: run.name,
    description: run.description,
    model: run.model,
    status: run.status,
    ...(run.readOnly ? { read_only: true } : {}),
    ...(run.worktree ? { branch: run.worktree.branch } : {}),
    started_at: run.startedAtIso,
    ...(run.error ? { error: run.error } : {}),
  };
}

function metaOfRun(run: SubagentRun): SubagentMeta {
  return {
    ...viewOfRun(run),
    ...(run.worktree ? { worktree: run.worktree.path } : {}),
    ...(run.endedAt ? { ended_at: new Date(run.endedAt).toISOString() } : {}),
  };
}

export function subagentNotification(run: SubagentRun): string {
  const status = run.status === "done" ? "completed" : run.status === "stopped" ? "stopped" : "failed";
  const summary = run.description || run.name;
  const header = run.worktree ? `[worktree: ${run.worktree.path} | branch: ${run.worktree.branch}]\n\n` : "";
  const full = `${header}${run.output}`.trim();
  const body = full.length > RESULT_CAP ? full.slice(0, RESULT_CAP) : full;
  return [
    "<task-notification>",
    "<kind>subagent</kind>",
    `<task-id>${run.id}</task-id>`,
    ...(run.subagentChatId ? [`<chat-id>${escapeXml(run.subagentChatId)}</chat-id>`] : []),
    `<status>${status}</status>`,
    `<summary>${escapeXml(summary)}</summary>`,
    `<result>${escapeXml(body)}</result>`,
    "</task-notification>",
  ].join("\n");
}

function formatRunResult(run: SubagentRun): string {
  const meta = [`subagent ${run.id}`, `status: ${run.status}`];
  if (run.model) meta.push(`model: ${run.model}`);
  if (run.readOnly) meta.push("read-only");
  if (run.worktree) meta.push(`branch: ${run.worktree.branch}`, `worktree: ${run.worktree.path}`);
  const head = `[${meta.join(" | ")}]`;
  return run.output ? `${head}\n${run.output}` : head;
}

function formatSyncFooter(run: SubagentRun, answer: string): string {
  const text = answer || "The helper finished without an answer.";
  if (!run.worktree) return text;
  return `${text}\n\n[subagent ${run.id} | branch: ${run.worktree.branch} | worktree: ${run.worktree.path}]`;
}

type Thinking = Agent["thinkingLevel"];

function clampThinking(model: Model<Api> | undefined, effort: ReasoningEffort | null): Thinking | undefined {
  const desired = thinkingLevel(effort);
  if (!desired || !model) return desired;
  const supported = getSupportedThinkingLevels(model);
  if (!supported.length) return desired === "off" ? "off" : undefined;
  if ((supported as readonly string[]).includes(desired)) return desired;
  if (desired === "off") return supported[0];
  return desired === "minimal" || desired === "low" ? supported[0] : supported[supported.length - 1];
}

function tierScore(m: Model<Api>, tier: "fast" | "strong"): number {
  const hint = tier === "fast" ? FAST_HINT : STRONG_HINT;
  if (m.cost.input > 0) return m.cost.input + (hint.test(m.id) ? (tier === "fast" ? -0.0001 : 0.0001) : 0);
  return hint.test(m.id) ? (tier === "fast" ? 0.01 : 1000) : 100;
}

function resolveSubagentModel(
  rawModel: string | undefined,
  rawEffort: unknown,
  parentModel: ModelRef | undefined,
  available: ReadonlyArray<Model<Api>>,
): { model?: ModelRef; handle: string | null; thinking?: Thinking } {
  let effort: ReasoningEffort | null = null;
  if (rawEffort !== undefined) {
    if (!isReasoningEffort(rawEffort)) {
      const shown = typeof rawEffort === "string" ? rawEffort : JSON.stringify(rawEffort);
      throw new Error(`invalid reasoning_effort "${shown}"`);
    }
    effort = rawEffort;
  }
  const spec = rawModel?.trim();
  if (!spec || spec === "inherit") {
    const full = parentModel ? available.find((m) => m.provider === parentModel.provider && m.id === parentModel.modelId) : undefined;
    return {
      handle: parentModel ? `${parentModel.provider}/${parentModel.modelId}` : null,
      ...(effort ? { thinking: clampThinking(full, effort) } : {}),
    };
  }
  if (spec === "fast" || spec === "strong") {
    if (!available.length) {
      return {
        handle: parentModel ? `${parentModel.provider}/${parentModel.modelId}` : null,
        thinking: thinkingLevel(effort ?? (spec === "fast" ? "low" : "high")),
      };
    }
    const sameProvider = parentModel ? available.filter((m) => m.provider === parentModel.provider) : [];
    const pool = sameProvider.length >= 2 ? sameProvider : available;
    const sorted = [...pool].sort((a, b) => (spec === "fast" ? tierScore(a, "fast") - tierScore(b, "fast") : tierScore(b, "strong") - tierScore(a, "strong")));
    const picked = sorted[0];
    return {
      model: { provider: picked.provider, modelId: picked.id },
      handle: `${picked.provider}/${picked.id}`,
      thinking: clampThinking(picked, effort ?? (spec === "fast" ? "low" : "high")),
    };
  }
  const ref = modelRef(spec);
  if (!ref) throw new Error(`invalid model "${spec}": use "inherit", "fast", "strong", or "provider/modelId"`);
  const found = available.find((m) => m.provider === ref.provider && m.id === ref.modelId);
  if (available.length > 0 && !found) {
    const sample = available
      .slice(0, 8)
      .map((m) => `${m.provider}/${m.id}`)
      .join(", ");
    throw new Error(`model "${spec}" is not connected (available: ${sample})`);
  }
  return {
    model: ref,
    handle: `${ref.provider}/${ref.modelId}`,
    ...(effort ? { thinking: clampThinking(found, effort) } : {}),
  };
}

export class SubagentManager {
  private readonly runs = new Map<string, SubagentRun>();
  private readonly changes = new Listeners<[agentId: string, parentChatId: string]>();
  private readonly notify: SubagentNotify | undefined;
  private readonly getStore: ((agentId: string) => Promise<AgentStore>) | undefined;
  readonly context: Context;
  private readonly worktreeOps: WorktreeOps | undefined;
  private readonly now: () => number;
  private readonly pickName: (used: ReadonlySet<string>) => string;
  private readonly startOffset = Math.floor(Math.random() * 64);

  constructor(options: SubagentManagerOptions = {}) {
    this.notify = options.notify;
    this.getStore = options.storeFor;
    this.context = options.context ?? BACKGROUND_CONTEXT;
    this.worktreeOps = options.worktreeOps ?? (options.worktreesDir ? defaultWorktreeOps(options.worktreesDir) : undefined);
    this.now = options.now ?? (() => Date.now());
    this.pickName = options.pickName ?? ((used) => pickSubagentName(used, this.startOffset));
  }

  hasStore(): boolean {
    return this.getStore !== undefined;
  }

  async storeFor(agentId: string): Promise<AgentStore> {
    if (!this.getStore) throw new Error("Persistent subagents are not enabled in this runtime.");
    return this.getStore(agentId);
  }

  onChange(listener: (agentId: string, parentChatId: string) => void): () => void {
    return this.changes.add(listener);
  }

  changed(agentId: string, parentChatId: string): void {
    this.changes.emit(agentId, parentChatId);
  }

  allocateName(agentId: string, persistedNames: ReadonlySet<string> = new Set()): string {
    const used = new Set<string>(persistedNames);
    for (const run of this.runs.values()) {
      if (run.agentId === agentId) used.add(run.id);
    }
    return this.pickName(used);
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
    this.changed(run.agentId, run.chatId);
  }

  private persist(run: SubagentRun): void {
    if (!this.getStore || !run.subagentChatId) return;
    const chatId = run.subagentChatId;
    void this.getStore(run.agentId)
      .then((store) => store.updateChat(chatId, { subagent_meta: metaOfRun(run) }, withoutAbortSignal(this.context)))
      .catch(() => {});
  }

  get(id: string, agentId: string): SubagentRun {
    const direct = this.runs.get(id);
    if (direct?.agentId === agentId) return direct;
    const byChat = [...this.runs.values()].find((r) => r.agentId === agentId && r.subagentChatId === id);
    if (!byChat) throw new Error(`no subagent ${id} (subagents end when loki's daemon restarts)`);
    return byChat;
  }

  list(agentId: string): string {
    const mine = [...this.runs.values()]
      .filter((r) => r.agentId === agentId)
      .sort((a, b) => Number(a.status !== "running") - Number(b.status !== "running") || b.startedAt - a.startedAt);
    if (!mine.length) return "No subagents.";
    return mine
      .map((r) => {
        const wt = r.worktree ? ` (branch ${r.worktree.branch})` : "";
        const ro = r.readOnly ? " [read-only]" : "";
        return `${r.id} [${r.status}]${ro}${wt} ${r.description || r.name}`;
      })
      .join("\n");
  }

  async views(agentId: string, parentChatId: string): Promise<SubagentView[]> {
    const byChatId = new Map<string, SubagentView>();
    if (this.getStore) {
      try {
        const store = await this.getStore(agentId);
        for (const info of await store.chats(this.context)) {
          if (info.subagent_for !== parentChatId || !info.subagent_meta) continue;
          const m = info.subagent_meta;
          byChatId.set(m.chat_id, {
            id: m.id,
            chat_id: m.chat_id,
            name: m.name,
            description: m.description,
            model: m.model,
            status: m.status === "running" ? "stopped" : m.status,
            ...(m.read_only ? { read_only: true } : {}),
            ...(m.branch ? { branch: m.branch } : {}),
            started_at: m.started_at,
            ...(m.error ? { error: m.error } : {}),
          });
        }
      } catch {}
    }
    for (const run of this.runs.values()) {
      if (run.agentId !== agentId || run.chatId !== parentChatId) continue;
      const view = viewOfRun(run);
      byChatId.set(view.chat_id, view);
    }
    return [...byChatId.values()].sort((a, b) => Number(a.status !== "running") - Number(b.status !== "running") || b.started_at.localeCompare(a.started_at));
  }

  modelChanged(agentId: string, subChatId: string, handle: string): void {
    const run = [...this.runs.values()].find((r) => r.agentId === agentId && r.subagentChatId === subChatId);
    if (run) {
      run.model = handle;
      this.persist(run);
      this.changed(run.agentId, run.chatId);
      return;
    }
    if (!this.getStore) return;
    void this.getStore(agentId)
      .then(async (store) => {
        const conv = await store.chat(subChatId, this.context);
        const info = conv ? await store.chatInfo(conv.id, this.context) : undefined;
        if (!info?.subagent_for || !info.subagent_meta) return;
        await store.updateChat(subChatId, { subagent_meta: { ...info.subagent_meta, model: handle } }, this.context);
        this.changed(agentId, info.subagent_for);
      })
      .catch(() => {});
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
          const msg = messageOf(error);
          run.status = "error";
          run.output = msg;
          run.error = msg;
          run.endedAt = this.now();
        }
      } finally {
        this.persist(run);
        this.changed(run.agentId, run.chatId);
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
    this.persist(run);
    this.changed(run.agentId, run.chatId);
    return `${wasRunning ? `Stopped subagent ${run.id}` : `Subagent ${run.id} already ${run.status}`}${worktreeNote}.`;
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
    parentAgent,
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
  model?: string;
  reasoning_effort?: ReasoningEffort;
  read_only?: boolean;
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
            description: "Delegate a task to an isolated named helper; model takes inherit, fast, strong, or provider/id.",
            parameters: {
              type: "object",
              properties: {
                prompt: { type: "string" },
                cwd: { type: "string" },
                workspace: { type: "string", enum: ["inherit", "worktree"] },
                async: { type: "boolean" },
                subagent_id: { type: "string" },
                model: { type: "string" },
                reasoning_effort: { type: "string" },
                read_only: { type: "boolean" },
              },
              required: ["prompt"],
            } as never,
            replay: "safe",
            execute: async (rawArgs, api, context) => {
              const args = rawArgs as SubagentArgs;
              const { agentId, chatId, parentChatDocId, parentAgent } = await callerInfo(api, context);
              const baseCwd = parentAgent.cwd ?? process.cwd();
              const description = typeof args.description === "string" ? args.description : "";

              let run: SubagentRun;
              if (args.subagent_id) {
                if (
                  args.cwd !== undefined ||
                  args.workspace === "worktree" ||
                  args.model !== undefined ||
                  args.reasoning_effort !== undefined ||
                  args.read_only !== undefined
                ) {
                  throw new Error("cwd, workspace, model, reasoning_effort, and read_only cannot be changed when continuing a subagent_id");
                }
                const existing = manager.get(args.subagent_id, agentId);
                if (existing.status === "running") throw new Error(`subagent ${args.subagent_id} is still running`);
                if (existing.status === "stopped") throw new Error(`subagent ${args.subagent_id} was stopped`);
                existing.status = "running";
                existing.output = "";
                existing.error = null;
                existing.endedAt = 0;
                existing.abort = new AbortController();
                if (description) existing.description = description;
                manager.changed(agentId, existing.chatId);
                run = existing;
              } else {
                if (args.read_only && args.workspace === "worktree") {
                  throw new Error("read_only subagents cannot use workspace: 'worktree'");
                }
                const available = await api.models.getAvailable();
                const resolvedModel = resolveSubagentModel(args.model, args.reasoning_effort, parentAgent.model, available);
                const requestedCwd = resolveOptionalCwd(args.cwd, baseCwd);

                const persistedNames = new Set<string>();
                let store: AgentStore | undefined;
                if (manager.hasStore()) {
                  store = await manager.storeFor(agentId);
                  for (const info of await store.chats(context)) {
                    const saved = info.subagent_meta?.id ?? subagentIdOfChat(info.id);
                    if (saved) persistedNames.add(saved);
                  }
                }
                const id = manager.allocateName(agentId, persistedNames);
                const name = subagentDisplayName(id);
                const worktree = args.workspace === "worktree" ? await manager.createWorktree(id, requestedCwd ?? baseCwd) : null;
                const effectiveCwd = worktree?.cwd ?? requestedCwd;
                const startedAt = Date.now();
                const startedAtIso = new Date(startedAt).toISOString();

                const readOnlyTools: ToolRegistration[] | undefined = args.read_only
                  ? (() => {
                      const byName = new Map<string, ToolRegistration>(api.registry.tools().map(({ tool }) => [tool.name, tool]));
                      return READ_ONLY_TOOLS.flatMap((n) => byName.get(n) ?? []);
                    })()
                  : undefined;
                const readOnlyExt = args.read_only ? api.registry.extension(READ_ONLY_EXTENSION) : undefined;
                if (args.read_only && !readOnlyExt) throw new Error(`${READ_ONLY_EXTENSION} extension is not installed`);

                try {
                  let conversationId: ConversationId;
                  let conversation: Conversation | undefined;
                  let subChatId: string | undefined;

                  if (store) {
                    subChatId = subagentChatId(chatId, id);
                    const parentAgentState = await api.snapshot(PiAgentDoc, api.conversationId, context);
                    const initialMeta: SubagentMeta = {
                      id,
                      chat_id: subChatId,
                      name,
                      description,
                      model: resolvedModel.handle,
                      status: "running",
                      ...(args.read_only ? { read_only: true } : {}),
                      ...(worktree ? { branch: worktree.branch, worktree: worktree.path } : {}),
                      started_at: startedAtIso,
                    };
                    conversation = await store.harness.createConversation(
                      {
                        ownership: { kind: "ownerless" },
                        init: async (tx, childId) => {
                          if (parentAgentState) Object.assign(await tx.doc(PiAgentDoc, childId), copyJson(parentAgentState));
                          await configure(tx, childId, {
                            ...(resolvedModel.model ? { model: resolvedModel.model } : {}),
                            ...(resolvedModel.thinking ? { thinkingLevel: resolvedModel.thinking } : {}),
                            ...(effectiveCwd ? { cwd: effectiveCwd } : {}),
                            extensions: {
                              ...(readOnlyExt ? { add: [readOnlyExt] } : {}),
                              remove: [extension, ...withoutAlso],
                            },
                            ...(readOnlyTools ? { tools: readOnlyTools, modelTools: readOnlyTools } : {}),
                          });
                          (await tx.doc(ChatIndex)).chats[subChatId ?? id] = childId;
                          const info = await tx.doc(ChatDoc, childId);
                          Object.assign(info, {
                            id: subChatId,
                            title: name,
                            hidden: true,
                            helper_for: api.conversationId,
                            subagent_for: chatId,
                            ...(args.read_only ? { read_only: true } : {}),
                            subagent_meta: initialMeta,
                          });
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
                        ...(resolvedModel.model ? { model: resolvedModel.model } : {}),
                        ...(resolvedModel.thinking ? { thinkingLevel: resolvedModel.thinking } : {}),
                        ...(effectiveCwd ? { cwd: effectiveCwd } : {}),
                        extensions: {
                          ...(readOnlyExt ? { add: [readOnlyExt] } : {}),
                          remove: [extension, ...withoutAlso],
                        },
                        ...(readOnlyTools ? { tools: readOnlyTools, modelTools: readOnlyTools } : {}),
                      });
                      const info = await tx.doc(ChatDoc, created.id);
                      Object.assign(info, {
                        id: parentChatDocId,
                        hidden: true,
                        helper_for: api.conversationId,
                        ...(args.read_only ? { read_only: true } : {}),
                      });
                      return created.id;
                    }, context);
                  }
                  run = {
                    id,
                    name,
                    agentId,
                    chatId,
                    ...(subChatId ? { subagentChatId: subChatId } : {}),
                    conversationId,
                    ...(conversation ? { conversation } : {}),
                    description,
                    model: resolvedModel.handle,
                    readOnly: Boolean(args.read_only),
                    ...(effectiveCwd ? { cwd: effectiveCwd } : {}),
                    worktree,
                    status: "running",
                    output: "",
                    error: null,
                    startedAt,
                    startedAtIso,
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
                const store = await manager.storeFor(agentId);
                const conv = run.conversation ?? (await store.harness.conversation(run.conversationId, context));
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
                if (run.status === "running") {
                  run.status = "stopped";
                  run.endedAt = Date.now();
                }
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
                  const msg = messageOf(error);
                  run.status = "error";
                  run.output = msg;
                  run.error = msg;
                  run.endedAt = Date.now();
                }
                throw error;
              } finally {
                context.abortSignal?.removeEventListener("abort", onAbort);
                if (storeForSyncPersist(manager, run)) {
                  manager.changed(run.agentId, run.chatId);
                }
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

function storeForSyncPersist(manager: SubagentManager, run: SubagentRun): boolean {
  if (!manager.hasStore() || !run.subagentChatId) return false;
  const chatId = run.subagentChatId;
  void manager
    .storeFor(run.agentId)
    .then((store) => store.updateChat(chatId, { subagent_meta: metaOfRun(run) }, withoutAbortSignal(manager.context)))
    .catch(() => {});
  return true;
}
