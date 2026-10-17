import type { Context } from "@earendil-works/chord";
import type { Conversation } from "@earendil-works/pi-durable";
import type * as acp from "@agentclientprotocol/sdk";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { contentText } from "../../core/harness.ts";
import type { ChatEvent } from "../../core/attention/model.ts";
import { messageSteps } from "../../core/attention/pi-steps.ts";
import type { ChatState, PayloadOf } from "../../core/frames.ts";
import { REASONING_EFFORTS, type ChatEngineView, type ModelEntry, type ReasoningEffort } from "../../core/models.ts";
import type { Approvals } from "../approvals.ts";
import type { AgentStore, ChatEngine, ChatInfo, UsageAdd } from "../kernel/index.ts";
import type { StoreManager } from "../kernel/stores.ts";
import type { EnginesView, EngineView } from "../../core/frame-types.ts";
import { CLAUDE_CODE, commandFound, readAcpAgents, writeAcpAgents, type AcpAgentConfig } from "./agents.ts";
import { AcpProcess } from "./process.ts";
import { acpTurnProperties } from "../telemetry.ts";

/**
 * Chats that run on an ACP agent (plan 020). Each chat has a session on its agent's process; a message is a
 * `session/prompt`, and what the agent reports as it works (`session/update`) becomes loki's chat events for every
 * client and, as each message completes, entries in the chat's own store. So the thread, the Inbox, history and the
 * passes read an ACP chat as they read any other (R7), and the usage the agent reports lands in the usage ledger
 * (R9). The agent's permission requests are loki's approval cards (KD10).
 */

interface Deps {
  stores: StoreManager;
  approvals: Approvals;
  context: Context;
  /** The ACP agents loki knows (daemon/acp/agents.ts), read on each use so an added agent needs no restart. */
  agents: () => AcpAgentConfig[];
  /** What is added to the agent's system prompt for a loki agent: its persona and memory (KD5); null for nothing. */
  systemPrompt?: (agentId: string) => string | null;
  /** The folder a chat with none set runs in. */
  homeDir: string;
  /** Analytics: each turn's `turn_finished` line (daemon/telemetry.ts); absent, nothing is recorded. */
  capture?: (event: string, properties: Record<string, unknown>) => void;
  /** The person's agents file (`state/acp.json`), which Settings › Engines edits; absent, the agents cannot be edited. */
  configFile?: string;
  /**
   * Where what each agent last offered (its models, modes and commands) is kept, so the model picker and a chat's
   * menus have them before the agent next starts; absent, they are kept only while the daemon runs.
   */
  cacheFile?: string;
  now?: () => Date;
}

/** What an agent offered in its last session: the model picker's and the mode chip's choices, and its commands. */
interface Offered {
  models: Array<{ value: string; name: string; description: string | null }>;
  modes: ChatEngineView["modes"];
  commands: ChatEngineView["commands"];
  /**
   * Each model's effort levels, by the model's value, as its `thought_level` option listed them (plan 021, R4). A
   * session reports only its current model's, so they gather as models are used; absent from a cache written
   * before this field.
   */
  efforts?: Record<string, string[]>;
}

/** An agent's effort levels that loki has words for, least to most; its own "default" and any others are left out. */
function knownEfforts(levels: string[] | undefined): ReasoningEffort[] {
  return REASONING_EFFORTS.filter((e) => levels?.includes(e));
}

/** A select option list, its groups flattened. */
function selectOptions(option: acp.SessionConfigOption | undefined): Offered["models"] {
  if (option?.type !== "select") return [];
  return option.options.flatMap((o) => ("options" in o ? o.options : [o])).map((o) => ({ value: o.value, name: o.name, description: o.description ?? null }));
}

/** A tool call in the turn running now: shown as it changes, written when it finishes. */
interface Call {
  name: string;
  args: unknown;
  /** The words the agent wrote before the call, which the stored assistant message carries with it. */
  textBefore: string;
  output: string;
  done: boolean;
  /** The agent said it failed, or the turn ended before it finished. */
  failed?: boolean;
}

/** Whether a call's arguments say anything yet (Claude's adapter opens a call as "Preparing file…" with none). */
const hasArgs = (args: unknown) => args !== undefined && args !== null && !(typeof args === "object" && Object.keys(args).length === 0);

/** The turn running in a chat. */
interface Turn {
  id: string;
  abort: AbortController;
  /** The words of the answer in flight, since the last tool call. */
  text: string;
  at: string | null;
  calls: Map<string, Call>;
  plan: acp.PlanEntry[] | null;
  /** The model the agent says answered (Claude's adapter names it on its usage updates). */
  model: string | null;
  /** Dollars the agent reported spending in this turn. */
  cost: number;
  /** Finished calls being written, which the turn's end waits for so its last words come after them. */
  writes: Array<Promise<void>>;
  /** For its `turn_finished` line: when it was sent and first answered (ms), and how many replies it wrote. */
  startedAt: number;
  firstOutputAt: number | null;
  responses: number;
}

/** One ACP chat as loki is running it now; made on first use, and forgotten when the daemon stops. */
interface Live {
  agentId: string;
  conversationId: string;
  agent: string;
  /** The model the chat runs on, as the picker named it. */
  model: string;
  /** The effort the chat asked for (plan 021); null leaves the agent's own. */
  effort: string | null;
  sessionId: string | null;
  /** The process start the session belongs to: a restarted agent has none of its sessions open. */
  epoch: number;
  /** The agent replays a loaded session's history as updates; loki has it already, so they are dropped. */
  loading: boolean;
  /** Words for the agent's first prompt of a session, when it takes no system prompt (KD5). */
  preamble: string | null;
  turn: Turn | null;
  queue: Promise<void>;
  sent: Set<string>;
  modes: acp.SessionModeState | null;
  configOptions: acp.SessionConfigOption[];
  commands: acp.AvailableCommand[];
  /** The agent's running total of dollars for the session (it reports the total, not each turn's). */
  costSoFar: number;
}

const key = (agentId: string, conversationId: string) => `${agentId}\u0000${conversationId}`;

/** A tool call's content as text: its words, a diff as a unified diff, a terminal by name. */
function contentOutput(content: acp.ToolCallContent[] | null | undefined): string {
  return (content ?? [])
    .map((c) => {
      if (c.type === "diff") {
        // A file's last newline ends its last line; it is not one more line.
        const lines = (text: string) => text.replace(/\n$/, "").split("\n");
        const old = lines(c.oldText ?? "").map((l) => `-${l}`);
        const now = lines(c.newText).map((l) => `+${l}`);
        return [`--- ${c.path}`, `+++ ${c.path}`, ...(c.oldText ? old : []), ...now].join("\n");
      }
      if (c.type === "terminal") return `(terminal ${c.terminalId})`;
      return c.content.type === "text" ? c.content.text : `[${c.content.type}]`;
    })
    .join("\n");
}

/** A raw output the agent attached, as text, when its content said nothing. */
function rawText(raw: unknown): string {
  if (raw === undefined || raw === null) return "";
  return typeof raw === "string" ? raw : JSON.stringify(raw, null, 2);
}

/** The plan as a checklist. */
function planText(entries: acp.PlanEntry[]): string {
  return entries.map((e) => `${e.status === "completed" ? "[x]" : e.status === "in_progress" ? "[~]" : "[ ]"} ${e.content}`).join("\n");
}

/** Why a turn stopped short, for the person; null when it simply ended. */
function stopNote(reason: acp.StopReason): string | null {
  if (reason === "refusal") return "the agent refused to continue";
  if (reason === "max_tokens") return "the agent's answer hit its length limit";
  if (reason === "max_turn_requests") return "the agent stopped after its most steps in one turn";
  return null;
}

/** The chats on ACP agents, as DaemonChats routes them here (daemon/chat-backend.ts). */
export class AcpChats {
  private push: (agentId: string, conversationId: string, events: ChatEvent[]) => void = () => {};
  private readonly live = new Map<string, Live>();
  private readonly bySession = new Map<string, Live>();
  /** Updates for a session loki has not registered yet (they can arrive with its `session/new` answer), replayed once it has. */
  private readonly early = new Map<string, acp.SessionNotification[]>();
  private readonly processes = new Map<string, AcpProcess>();
  private readonly offered: Map<string, Offered>;
  /** How each agent last went: a message through, a start, or a failure with its reason (Settings › Engines). */
  private readonly health = new Map<string, { status: "ready" | "started" | "failed"; detail: string | null }>();
  private readonly deps: Deps;

  constructor(deps: Deps) {
    this.deps = deps;
    this.offered = new Map(Object.entries(this.readCache()));
  }

  private readCache(): Record<string, Offered> {
    try {
      const parsed: unknown = this.deps.cacheFile ? JSON.parse(readFileSync(this.deps.cacheFile, "utf8")) : null;
      return parsed && typeof parsed === "object" ? (parsed as Record<string, Offered>) : {};
    } catch {
      return {};
    }
  }

  /** Remember what a session offers, for the picker and for chats whose agent is not running now. */
  private remember(live: Live): void {
    const known = this.offered.get(live.agent);
    const modeOption = live.configOptions.find((o) => o.category === "mode");
    const modelOption = live.configOptions.find((o) => o.category === "model");
    const effortOption = live.configOptions.find((o) => o.category === "thought_level");
    const efforts = { ...known?.efforts };
    if (effortOption?.type === "select") {
      const levels = selectOptions(effortOption)
        .map((o) => o.value)
        .filter((v) => v !== "default");
      // Filed under the model the agent says it is on, and under the chat's own name for it ("default").
      for (const model of new Set([modelOption?.type === "select" ? modelOption.currentValue : null, live.model])) if (model) efforts[model] = levels;
    }
    const next: Offered = {
      models: selectOptions(modelOption),
      modes: live.modes
        ? live.modes.availableModes.map((m) => ({ id: m.id, name: m.name, description: m.description ?? null }))
        : selectOptions(modeOption).map((o) => ({ id: o.value, name: o.name, description: o.description })),
      commands: live.commands.length
        ? live.commands.map((c) => ({ name: c.name, description: c.description, hint: c.input?.hint ?? null }))
        : (known?.commands ?? []),
      ...(Object.keys(efforts).length ? { efforts } : {}),
    };
    if (JSON.stringify(next) === JSON.stringify(known)) return;
    this.offered.set(live.agent, next);
    if (!this.deps.cacheFile) return;
    try {
      mkdirSync(dirname(this.deps.cacheFile), { recursive: true });
      writeFileSync(this.deps.cacheFile, `${JSON.stringify(Object.fromEntries(this.offered), null, 2)}\n`);
    } catch {
      // Only a convenience: the next session offers them again.
    }
  }

  /** Settings › Engines: every agent, how it starts and how it stands. */
  engines(): EnginesView {
    return {
      engines: this.deps.agents().map((a): EngineView => {
        const builtin = a.id === CLAUDE_CODE.id;
        const health = this.health.get(a.id);
        const failed = health?.status === "failed" ? (health.detail ?? "") : null;
        // An agent that needs signing in says so in its own words; loki only tells the two kinds of failure apart.
        const signedOut = failed !== null && /auth|sign.?in|log.?in|credential/i.test(failed);
        const status: EngineView["status"] = !commandFound(a.command, { ...process.env, ...a.env })
          ? "not_found"
          : signedOut
            ? "signed_out"
            : (health?.status ?? "unknown");
        const detail =
          status === "not_found"
            ? `${a.command} is not on loki's PATH${a.command === "npx" ? "; install Node" : ""}`
            : status === "signed_out"
              ? builtin
                ? "run claude /login in a terminal, then send again"
                : `sign in to ${a.name}, then send again`
              : (health?.detail ?? null);
        const changed = builtin && JSON.stringify(a) !== JSON.stringify(CLAUDE_CODE);
        return { id: a.id, name: a.name, command: a.command, args: a.args, builtin, changed, status, detail };
      }),
      config_path: this.deps.configFile ?? "",
    };
  }

  private editAgents(change: (agents: AcpAgentConfig[]) => AcpAgentConfig[], id: string): EnginesView {
    if (!this.deps.configFile) throw new Error("this daemon keeps no agents file");
    writeAcpAgents(this.deps.configFile, change(readAcpAgents(this.deps.configFile)));
    // The next message starts it the new way.
    void this.processes.get(id)?.close();
    this.processes.delete(id);
    this.health.delete(id);
    return this.engines();
  }

  /** Add an agent, or change how one starts (Claude Code's change is kept as an override of the built-in one). */
  setEngine(agent: AcpAgentConfig): Promise<EnginesView> {
    return Promise.resolve(this.editAgents((agents) => [...agents.filter((a) => a.id !== agent.id), agent], agent.id));
  }

  /** Remove an agent; Claude Code goes back to how loki ships it. */
  removeEngine(id: string): Promise<EnginesView> {
    return Promise.resolve(
      this.editAgents((agents) => (id === CLAUDE_CODE.id ? [CLAUDE_CODE, ...agents.filter((a) => a.id !== id)] : agents.filter((a) => a.id !== id)), id),
    );
  }

  /** Start an agent afresh and initialize it, to see that it starts; sign-in shows only on a first message. */
  async checkEngine(id: string): Promise<EnginesView> {
    const proc = this.process(id);
    await proc.close();
    try {
      await proc.capabilities();
      if (this.health.get(id)?.status !== "ready") this.health.set(id, { status: "started", detail: "it starts; sign-in shows on the first message" });
    } catch (error) {
      this.health.set(id, { status: "failed", detail: proc.failure(error).message });
    }
    return this.engines();
  }

  /** The chat's engine as the app shows it: the agent's name, the model, and its modes and commands. */
  view(agentId: string, conversationId: string, engine: ChatEngine): ChatEngineView {
    const offered = this.offered.get(engine.agent);
    return {
      agent: engine.agent,
      name: this.agent(engine.agent)?.name ?? engine.agent,
      model: engine.model,
      modes: offered?.modes ?? [],
      commands: offered?.commands ?? [],
    };
  }

  /** Tell every client the chat's engine changed (its modes or commands arrived), and its mode when that is known. */
  private pushView(live: Live, engine: Pick<ChatEngine, "agent" | "model">, mode?: string): void {
    const view = this.view(live.agentId, live.conversationId, { kind: "acp", session_id: null, ...engine });
    this.push(live.agentId, live.conversationId, [{ kind: "device", engine: view, ...(mode ? { mode } : {}) }]);
  }

  /** The mode the agent's session is in now: its mode state, or its mode option. */
  private currentMode(live: Live): string | null {
    if (live.modes) return live.modes.currentModeId;
    const option = live.configOptions.find((o) => o.category === "mode");
    return option?.type === "select" ? option.currentValue : null;
  }

  /**
   * Each ACP agent's models for the model picker: what it offered last, or its default before it has run. Its
   * default is featured, so the agent is among the quick picks. A model whose effort levels are known is one entry
   * per level, as loki's own presets are (plan 021, R4).
   */
  models(): ModelEntry[] {
    return this.deps.agents().flatMap((agent) => {
      const offered = this.offered.get(agent.id);
      const models = offered?.models ?? [];
      const choices = models.some((m) => m.value === "default") ? models : [{ value: "default", name: "Default", description: null }, ...models];
      return choices.flatMap((m) => {
        const handle = `acp:${agent.id}/${m.value}`;
        const entry: ModelEntry = {
          id: handle,
          handle,
          label: m.value === "default" ? agent.name : `${agent.name} · ${m.name}`,
          // Its default says what the agent is; its other models are under the agent's tab, so need no such line.
          ...(m.description ? { description: m.description } : m.value === "default" ? { description: `runs on ${agent.name}, signed in as you` } : {}),
          ...(m.value === "default" ? { is_featured: true } : {}),
        };
        const efforts = knownEfforts(offered?.efforts?.[m.value]);
        return efforts.length ? efforts.map((e): ModelEntry => ({ ...entry, id: `${handle}@${e}`, reasoning_effort: e })) : [entry];
      });
    });
  }

  attach(push: (agentId: string, conversationId: string, events: ChatEvent[]) => void): void {
    this.push = push;
  }

  private now(): string {
    return (this.deps.now?.() ?? new Date()).toISOString();
  }

  /** The agent named `id`, if loki knows it. */
  agent(id: string): AcpAgentConfig | undefined {
    return this.deps.agents().find((a) => a.id === id);
  }

  /** The agent's process, made on first use (it starts when first asked for something). */
  private process(agent: string): AcpProcess {
    let proc = this.processes.get(agent);
    if (!proc) {
      const config = this.agent(agent);
      if (!config) throw new Error(`no ACP agent named ${agent}; add it in Settings`);
      proc = new AcpProcess(config, {
        update: (n) => this.update(n),
        permission: (r) => this.permission(r),
      });
      this.processes.set(agent, proc);
    }
    return proc;
  }

  private liveOf(agentId: string, conversationId: string, engine: ChatEngine): Live {
    let live = this.live.get(key(agentId, conversationId));
    if (!live) {
      live = {
        agentId,
        conversationId,
        agent: engine.agent,
        model: engine.model,
        effort: engine.effort ?? null,
        sessionId: null,
        epoch: -1,
        loading: false,
        preamble: null,
        turn: null,
        queue: Promise.resolve(),
        sent: new Set(),
        modes: null,
        configOptions: [],
        commands: [],
        costSoFar: 0,
      };
      this.live.set(key(agentId, conversationId), live);
    }
    return live;
  }

  private async chat(agentId: string, conversationId: string): Promise<{ store: AgentStore; chat: Conversation; info: Readonly<ChatInfo> }> {
    const store = await this.deps.stores.get(agentId);
    const chat = await store.chat(conversationId, this.deps.context);
    const info = chat ? await store.chatInfo(chat.id, this.deps.context) : undefined;
    if (!chat || !info) throw new Error(`no chat ${conversationId} for ${agentId}`);
    return { store, chat, info };
  }

  /** Whether a turn is running in the chat or waits on the person. */
  busy(agentId: string, conversationId: string): boolean {
    return Boolean(this.live.get(key(agentId, conversationId))?.turn) || this.deps.approvals.waitingIn(agentId, conversationId).length > 0;
  }

  /** The chat as a client opening it sees it: running or not, the answer in flight, its mode and folder. */
  async state(agentId: string, conversationId: string): Promise<ChatState> {
    const { store, chat, info } = await this.chat(agentId, conversationId);
    const live = this.live.get(key(agentId, conversationId));
    const settings = (await store.agentSettings(chat.id, this.deps.context)) as { cwd?: string } | undefined;
    const waiting = this.deps.approvals.waitingIn(agentId, conversationId).length > 0;
    const turn = live?.turn ?? null;
    return {
      agent_id: agentId,
      conversation_id: conversationId,
      loop: waiting ? "approval" : turn ? "running" : "idle",
      turn_id: turn?.id ?? null,
      mode: info.mode ?? live?.modes?.currentModeId ?? null,
      cwd: settings?.cwd ?? null,
      engine: info.engine?.kind === "acp" ? this.view(agentId, conversationId, info.engine) : null,
      ...(turn?.text ? { streaming: { text: turn.text, at: turn.at } } : {}),
    };
  }

  /** The person's message: it waits for the turn before it, then runs as its own (a message sent twice runs once). */
  send(p: PayloadOf<"chat_send">, engine: ChatEngine): void {
    const live = this.liveOf(p.agent_id, p.conversation_id, engine);
    if (p.send_id) {
      if (live.sent.has(p.send_id)) return;
      live.sent.add(p.send_id);
    }
    const text = [p.context, p.text.trim() ? p.text : null].filter((t): t is string => Boolean(t)).join("\n\n");
    this.enqueue(live, text, p.images);
  }

  /** A message from loki itself (a schedule's prompt, a background task's notice): queued like the person's. */
  deliver(agentId: string, conversationId: string, text: string, engine: ChatEngine): void {
    this.enqueue(this.liveOf(agentId, conversationId, engine), text, []);
  }

  private enqueue(live: Live, text: string, images: PayloadOf<"chat_send">["images"]): void {
    live.queue = live.queue.then(() => this.run(live, text, images)).catch(() => {});
  }

  /** Stop the turn running now: what waits on the person is withdrawn, and the agent is asked to cancel. */
  async abort(agentId: string, conversationId: string): Promise<void> {
    const live = this.live.get(key(agentId, conversationId));
    if (!live?.turn) return;
    live.turn.abort.abort();
    if (live.sessionId) await this.process(live.agent).cancel(live.sessionId);
  }

  /** The agent's mode for the chat (KD10): remembered on the chat, and set on its session when one is open. */
  async setMode(agentId: string, conversationId: string, modeId: string): Promise<void> {
    const { store } = await this.chat(agentId, conversationId);
    await store.updateChat(conversationId, { mode: modeId }, this.deps.context);
    const live = this.live.get(key(agentId, conversationId));
    if (live?.sessionId && live.epoch === this.process(live.agent).epoch()) await this.applyMode(live, modeId);
    this.push(agentId, conversationId, [{ kind: "device", mode: modeId }]);
  }

  /** The agent's model and effort for the chat: set on its session when one is open; a new session starts on them. */
  async setModel(agentId: string, conversationId: string, model: string, effort: string | null = null): Promise<void> {
    const live = this.live.get(key(agentId, conversationId));
    if (!live) return;
    live.model = model;
    live.effort = effort;
    if (live.sessionId && live.epoch === this.process(live.agent).epoch()) {
      await this.applyModel(live, model);
      await this.applyEffort(live, effort);
      this.remember(live);
    }
    this.pushView(live, { agent: live.agent, model });
  }

  /** The slash commands the agent offers in this chat, as it last listed them. */
  commands(agentId: string, conversationId: string): acp.AvailableCommand[] {
    return this.live.get(key(agentId, conversationId))?.commands ?? [];
  }

  /** Stop every agent process; the daemon is stopping. */
  async close(): Promise<void> {
    await Promise.all([...this.processes.values()].map((p) => p.close()));
  }

  private async applyMode(live: Live, modeId: string): Promise<void> {
    if (!live.sessionId) return;
    const proc = this.process(live.agent);
    if (live.modes?.availableModes.some((m) => m.id === modeId)) {
      if (live.modes.currentModeId === modeId) return;
      await proc.setMode(live.sessionId, modeId);
      live.modes = { ...live.modes, currentModeId: modeId };
      return;
    }
    const option = live.configOptions.find((o) => o.category === "mode" && o.type === "select");
    if (option?.type === "select" && option.currentValue !== modeId)
      live.configOptions = (await proc.setConfigOption(live.sessionId, option.id, modeId)).configOptions;
  }

  private async applyModel(live: Live, model: string): Promise<void> {
    if (!live.sessionId || model === "default") return;
    const option = live.configOptions.find((o) => o.category === "model" && o.type === "select");
    if (option?.type === "select" && option.currentValue !== model) {
      live.configOptions = (await this.process(live.agent).setConfigOption(live.sessionId, option.id, model)).configOptions;
    }
  }

  /** The chat's effort on its session, when the agent offers that level for the model it is on now; null leaves the agent's. */
  private async applyEffort(live: Live, effort: string | null): Promise<void> {
    if (!live.sessionId || !effort) return;
    const option = live.configOptions.find((o) => o.category === "thought_level" && o.type === "select");
    if (option?.type !== "select" || option.currentValue === effort || !selectOptions(option).some((o) => o.value === effort)) return;
    live.configOptions = (await this.process(live.agent).setConfigOption(live.sessionId, option.id, effort)).configOptions;
  }

  /**
   * The chat's session on its agent, opened if it has none on the running process: the one it had, loaded, when the
   * agent can load sessions (R8); otherwise a new one, and the chat says the agent starts afresh.
   */
  private async session(live: Live, store: AgentStore, chat: Conversation, info: Readonly<ChatInfo>, engine: ChatEngine): Promise<string> {
    const proc = this.process(live.agent);
    const caps = await proc.capabilities();
    if (live.sessionId && live.epoch === proc.epoch()) return live.sessionId;
    const settings = (await store.agentSettings(chat.id, this.deps.context)) as { cwd?: string } | undefined;
    const cwd = settings?.cwd ?? this.deps.homeDir;
    const prompt = this.deps.systemPrompt?.(live.agentId) ?? null;
    const takesPrompt = Boolean(caps.sessionCapabilities?.systemPrompt);
    const systemPrompt = prompt && takesPrompt ? { systemPrompt: { mode: "append" as const, content: [{ type: "text" as const, text: prompt }] } } : {};
    if (live.sessionId) this.bySession.delete(live.sessionId);
    let opened: { sessionId: string; modes?: acp.SessionModeState | null; configOptions?: acp.SessionConfigOption[] | null } | null = null;
    if (engine.session_id && caps.loadSession) {
      live.sessionId = engine.session_id;
      this.bySession.set(engine.session_id, live);
      live.loading = true;
      try {
        opened = { sessionId: engine.session_id, ...(await proc.loadSession({ sessionId: engine.session_id, cwd, mcpServers: [], ...systemPrompt })) };
      } catch {
        // The agent no longer has it (its own history was cleared, say): a new session, said so below.
        opened = null;
      } finally {
        live.loading = false;
      }
    }
    if (!opened) {
      if (engine.session_id) {
        const note = "the agent could not pick up where this chat left off, so it starts afresh; it does not remember the messages above";
        this.push(live.agentId, live.conversationId, [{ kind: "error", message: note }]);
      }
      opened = await proc.newSession({ cwd, mcpServers: [], ...systemPrompt });
      // Known before anything else is awaited: the agent sends its commands right after it answers.
      this.register(opened.sessionId, live);
      await store.updateChat(live.conversationId, { engine: { ...engine, session_id: opened.sessionId } }, this.deps.context);
    }
    live.sessionId = opened.sessionId;
    live.epoch = proc.epoch();
    live.modes = opened.modes ?? null;
    live.configOptions = opened.configOptions ?? [];
    live.preamble = prompt && !takesPrompt ? prompt : null;
    this.register(opened.sessionId, live);
    await this.applyModel(live, engine.model);
    await this.applyEffort(live, engine.effort ?? null);
    this.remember(live);
    // The chat's mode, when it is one of the agent's; otherwise the chat takes the mode the agent is in.
    const offered = this.offered.get(live.agent)?.modes ?? [];
    if (info.mode && offered.some((m) => m.id === info.mode)) await this.applyMode(live, info.mode).catch(() => {});
    const mode = this.currentMode(live);
    if (mode && mode !== info.mode) await store.updateChat(live.conversationId, { mode }, this.deps.context);
    this.pushView(live, engine, mode ?? undefined);
    return opened.sessionId;
  }

  /** One turn: the message written and shown, sent to the agent, and the chat settled when it answers or fails. */
  private async run(live: Live, text: string, images: PayloadOf<"chat_send">["images"]): Promise<void> {
    const { store, chat, info } = await this.chat(live.agentId, live.conversationId);
    if (info.engine?.kind !== "acp") return;
    const proc = this.process(live.agent);
    const turn: Turn = {
      id: `acp-${randomUUID()}`,
      abort: new AbortController(),
      text: "",
      at: null,
      calls: new Map(),
      plan: null,
      model: null,
      cost: 0,
      writes: [],
      startedAt: 0,
      firstOutputAt: null,
      responses: 0,
    };
    live.turn = turn;
    const at = this.now();
    turn.startedAt = Date.parse(at);
    const content = [
      ...(text ? [{ type: "text" as const, text }] : []),
      ...images.map((i) => ({ type: "image" as const, data: i.data, mimeType: i.media_type })),
    ];
    this.push(live.agentId, live.conversationId, [
      { kind: "loop", state: "running", turn_id: turn.id },
      { kind: "step", step: { kind: "user", raw: contentText(content), at } },
    ]);
    await store.appendEntries(chat, [{ kind: "pi.user", message: { role: "user", content, timestamp: Date.parse(at) } }], null, this.deps.context);
    let usage: acp.Usage | null = null;
    let stopReason: acp.StopReason | null = null;
    try {
      const sessionId = await this.session(live, store, chat, info, info.engine);
      const caps = await proc.capabilities();
      const prompt: acp.ContentBlock[] = [
        ...(live.preamble ? [{ type: "text" as const, text: `<loki-agent>\n${live.preamble}\n</loki-agent>` }] : []),
        ...(text ? [{ type: "text" as const, text }] : []),
        ...(caps.promptCapabilities?.image ? images.map((i) => ({ type: "image" as const, data: i.data, mimeType: i.media_type })) : []),
      ];
      live.preamble = null;
      if (images.length && !caps.promptCapabilities?.image)
        this.push(live.agentId, live.conversationId, [{ kind: "error", message: "this agent takes no pictures; they were not sent" }]);
      const response = await proc.prompt({ sessionId, prompt });
      usage = response.usage ?? null;
      stopReason = response.stopReason;
      await this.finish(live, store, chat, turn, usage, info.engine);
      this.health.set(live.agent, { status: "ready", detail: null });
      const note = stopNote(response.stopReason);
      if (note) this.push(live.agentId, live.conversationId, [{ kind: "error", message: note }]);
    } catch (error) {
      await this.finish(live, store, chat, turn, null, info.engine).catch(() => {});
      const message = proc.failure(error).message;
      this.health.set(live.agent, { status: "failed", detail: message.split("\n")[0] });
      this.push(live.agentId, live.conversationId, [{ kind: "error", message }]);
    } finally {
      live.turn = null;
      this.push(live.agentId, live.conversationId, [{ kind: "settle" }, { kind: "loop", state: "idle" }, { kind: "turn_end", turn_id: turn.id }]);
      this.measure(live, turn, info.engine, usage, stopReason);
    }
  }

  /** The turn's `turn_finished` line: what the agent reported, and what loki saw go by. */
  private measure(live: Live, turn: Turn, engine: ChatEngine, usage: acp.Usage | null, stopReason: acp.StopReason | null): void {
    const calls = [...turn.calls.values()];
    this.deps.capture?.(
      "turn_finished",
      acpTurnProperties({
        agentId: live.agentId,
        chatId: live.conversationId,
        turnId: turn.id,
        model: `acp:${engine.agent}/${turn.model ?? engine.model}`,
        agent: engine.agent,
        startedAt: turn.startedAt,
        firstOutputAt: turn.firstOutputAt,
        endedAt: Date.parse(this.now()),
        usage: usage && {
          input: usage.inputTokens,
          output: usage.outputTokens,
          cacheRead: usage.cachedReadTokens ?? 0,
          cacheWrite: usage.cachedWriteTokens ?? 0,
          reasoning: usage.thoughtTokens ?? 0,
        },
        cost: turn.cost,
        responses: turn.responses,
        toolCalls: calls.length,
        toolFailures: calls.filter((c) => c.failed).length,
        stopReason,
        failed: stopReason === null,
      }),
    );
  }

  /** The end of a turn: calls left open fail, the plan and the last words are written, and the usage counted. */
  private async finish(live: Live, store: AgentStore, chat: Conversation, turn: Turn, usage: acp.Usage | null, engine: ChatEngine): Promise<void> {
    await Promise.allSettled(turn.writes);
    // One at a time, in the order the calls were made: the thread is read back in the order its entries were written.
    for (const [id, call] of turn.calls) {
      if (call.done) continue;
      call.done = true;
      call.failed = true;
      turn.responses++;
      await this.writeCall(live, store, chat, id, call, true, call.output || "the tool did not finish");
    }
    const at = this.now();
    const entries: Array<{ kind: "pi.assistant" | "pi.tool-result"; message: Record<string, unknown> }> = [];
    if (turn.plan) {
      const id = `plan-${turn.id}`;
      turn.responses++;
      entries.push(
        { kind: "pi.assistant", message: { role: "assistant", content: [{ type: "toolCall", id, name: "plan", arguments: {} }], timestamp: Date.parse(at) } },
        {
          kind: "pi.tool-result",
          message: {
            role: "toolResult",
            toolCallId: id,
            toolName: "plan",
            content: [{ type: "text", text: planText(turn.plan) }],
            isError: false,
            timestamp: Date.parse(at),
          },
        },
      );
    }
    const words = turn.text;
    turn.text = "";
    if (words) {
      turn.responses++;
      const message = { role: "assistant", content: [{ type: "text", text: words }], timestamp: Date.parse(turn.at ?? at) };
      entries.push({ kind: "pi.assistant", message });
      this.push(
        live.agentId,
        live.conversationId,
        messageSteps(message, turn.at ?? at).map((step) => ({ kind: "step", step })),
      );
    }
    const add: UsageAdd | null =
      usage || turn.cost
        ? {
            input: usage?.inputTokens ?? 0,
            output: usage?.outputTokens ?? 0,
            cacheRead: usage?.cachedReadTokens ?? 0,
            cacheWrite: usage?.cachedWriteTokens ?? 0,
            cost: turn.cost,
          }
        : null;
    if (entries.length || add)
      await store.appendEntries(chat, entries, add ? { model: `acp:${engine.agent}/${turn.model ?? engine.model}`, add } : null, this.deps.context);
  }

  /** A tool call that finished (or never will): its call and its result written, and the result shown. */
  private async writeCall(live: Live, store: AgentStore, chat: Conversation, id: string, call: Call, failed: boolean, output: string): Promise<void> {
    const at = Date.parse(this.now());
    const content = [
      ...(call.textBefore ? [{ type: "text", text: call.textBefore }] : []),
      { type: "toolCall", id, name: call.name, arguments: call.args ?? {} },
    ];
    const result = [{ type: "text", text: output }];
    this.push(live.agentId, live.conversationId, [
      { kind: "step", step: { kind: "call", name: call.name, args: call.args, id, at: new Date(at).toISOString() } },
      { kind: "step", step: { kind: "result", id, output: result, failed } },
    ]);
    await store.appendEntries(
      chat,
      [
        { kind: "pi.assistant", message: { role: "assistant", content, timestamp: at } },
        { kind: "pi.tool-result", message: { role: "toolResult", toolCallId: id, toolName: call.name, content: result, isError: failed, timestamp: at } },
      ],
      null,
      this.deps.context,
    );
  }

  /** A session is the chat's from now on; what it reported before loki knew it is taken in now. */
  private register(sessionId: string, live: Live): void {
    if (this.bySession.get(sessionId) === live) return;
    this.bySession.set(sessionId, live);
    const early = this.early.get(sessionId) ?? [];
    this.early.delete(sessionId);
    for (const n of early) this.update(n);
  }

  /** What the agent reports as it works, for whichever chat the session is. */
  private update(n: acp.SessionNotification): void {
    const live = this.bySession.get(n.sessionId);
    if (!live) {
      // A few, for a few sessions: only what comes between an answer and its session being registered.
      const held = this.early.get(n.sessionId) ?? [];
      if (held.length < 20) this.early.set(n.sessionId, [...held, n]);
      if (this.early.size > 8) this.early.delete(this.early.keys().next().value ?? "");
      return;
    }
    const u = n.update;
    const push = (events: ChatEvent[]) => this.push(live.agentId, live.conversationId, events);
    switch (u.sessionUpdate) {
      case "current_mode_update":
        if (live.modes) live.modes = { ...live.modes, currentModeId: u.currentModeId };
        void this.deps.stores
          .get(live.agentId)
          .then((store) => store.updateChat(live.conversationId, { mode: u.currentModeId }, this.deps.context))
          .catch(() => {});
        push([{ kind: "device", mode: u.currentModeId }]);
        return;
      case "available_commands_update":
        live.commands = u.availableCommands;
        this.remember(live);
        this.pushView(live, { agent: live.agent, model: live.model });
        return;
      case "config_option_update":
        live.configOptions = u.configOptions;
        this.remember(live);
        return;
    }
    // A loaded session's history, replayed: loki has it already.
    if (live.loading) return;
    const turn = live.turn;
    if (!turn) return;
    const now = this.now();
    switch (u.sessionUpdate) {
      case "agent_message_chunk":
        if (u.content.type !== "text" || !u.content.text) return;
        turn.at ??= now;
        turn.firstOutputAt ??= Date.parse(now);
        turn.text += u.content.text;
        push([{ kind: "step", step: { kind: "assistant", text: u.content.text, at: now, chunk: true } }]);
        return;
      case "tool_call": {
        turn.firstOutputAt ??= Date.parse(now);
        // The words so far belong before the call: they settle as written, and go into the call's stored message.
        const call: Call = {
          name: u.title || u.name || u.kind || "tool",
          args: u.rawInput ?? {},
          textBefore: turn.text,
          output: contentOutput(u.content),
          done: false,
        };
        if (turn.text) push([{ kind: "step", step: { kind: "assistant", text: turn.text, at: turn.at ?? now } }]);
        turn.text = "";
        turn.at = null;
        turn.calls.set(u.toolCallId, call);
        // A call is shown once it has arguments, not under the agent's placeholder title.
        if (hasArgs(call.args)) {
          push([{ kind: "step", step: { kind: "call", name: call.name, args: call.args, id: u.toolCallId, at: now } }]);
        }
        if (u.status === "completed" || u.status === "failed") this.completeCall(live, turn, u.toolCallId, call, u.status === "failed", rawText(u.rawOutput));
        return;
      }
      case "tool_call_update": {
        const call = turn.calls.get(u.toolCallId);
        if (!call || call.done) return;
        if (u.title) call.name = u.title;
        if (u.rawInput !== undefined) call.args = u.rawInput;
        const output = contentOutput(u.content);
        if (output) call.output = output;
        if (u.status === "completed" || u.status === "failed") this.completeCall(live, turn, u.toolCallId, call, u.status === "failed", rawText(u.rawOutput));
        else if ((u.title || u.rawInput !== undefined) && hasArgs(call.args)) {
          push([{ kind: "step", step: { kind: "call", name: call.name, args: call.args, id: u.toolCallId, at: now } }]);
        }
        return;
      }
      case "plan":
        turn.plan = u.entries;
        push([
          { kind: "step", step: { kind: "call", name: "plan", args: {}, id: `plan-${turn.id}`, at: now } },
          { kind: "step", step: { kind: "result", id: `plan-${turn.id}`, output: [{ type: "text", text: planText(u.entries) }], failed: false } },
        ]);
        return;
      case "usage_update": {
        const model = u._meta?.["_claude/model"];
        if (typeof model === "string" && model) turn.model = model;
        if (u.cost?.currency === "USD") {
          // A total below the last one is a new session's (the agent restarted): all of it is new.
          turn.cost += u.cost.amount >= live.costSoFar ? u.cost.amount - live.costSoFar : u.cost.amount;
          live.costSoFar = u.cost.amount;
        }
        return;
      }
      default:
        return;
    }
  }

  /** A call the agent says finished: done now (so the turn's end leaves it be), written in the background. */
  private completeCall(live: Live, turn: Turn, id: string, call: Call, failed: boolean, raw: string): void {
    call.done = true;
    call.failed = failed;
    turn.responses++;
    const output = call.output || raw || (failed ? "the tool failed" : "done");
    turn.writes.push(this.chat(live.agentId, live.conversationId).then(({ store, chat }) => this.writeCall(live, store, chat, id, call, failed, output)));
  }

  /**
   * The agent asks before a tool call: a loki approval card with the agent's own choices behind it. Allow picks its
   * "allow once" (or "always allow" when the person ticked always), deny its "reject once"; a stopped turn answers
   * cancelled, as ACP asks.
   */
  private async permission(r: acp.RequestPermissionRequest): Promise<acp.RequestPermissionResponse> {
    const live = this.bySession.get(r.sessionId);
    if (!live?.turn) return { outcome: { outcome: "cancelled" } };
    const call = live.turn.calls.get(r.toolCall.toolCallId);
    const event = {
      kind: "approval" as const,
      request_id: `acp-${randomUUID()}`,
      tool_name: r.toolCall.title || call?.name || r.toolCall.name || "tool",
      input: r.toolCall.rawInput ?? call?.args ?? {},
    };
    try {
      const d = await this.deps.approvals.ask<{ allow: boolean; always?: boolean }>(live.agentId, live.conversationId, event, live.turn.abort.signal, {
        remember: false,
      });
      const pick = (...kinds: acp.PermissionOptionKind[]) => kinds.map((k) => r.options.find((o) => o.kind === k)).find((o) => o !== undefined);
      const option = d.allow ? (d.always ? pick("allow_always", "allow_once") : pick("allow_once", "allow_always")) : pick("reject_once", "reject_always");
      return option ? { outcome: { outcome: "selected", optionId: option.optionId } } : { outcome: { outcome: "cancelled" } };
    } catch {
      return { outcome: { outcome: "cancelled" } };
    }
  }
}
