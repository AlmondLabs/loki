import type { Context } from "@earendil-works/chord";
import type { Conversation } from "@earendil-works/pi-durable";
import type * as acp from "@agentclientprotocol/sdk";
import { randomUUID } from "node:crypto";
import { contentText } from "../../core/harness.ts";
import type { ChatEvent } from "../../core/attention/model.ts";
import { messageSteps } from "../../core/attention/pi-steps.ts";
import type { ChatState, PayloadOf } from "../../core/frames.ts";
import type { ChatEngineView, ModelEntry } from "../../core/models.ts";
import type { Approvals } from "../approvals.ts";
import type { AgentStore, ChatEngine, ChatInfo, UsageAdd } from "../kernel/index.ts";
import type { StoreManager } from "../kernel/stores.ts";
import type { EnginesView } from "../../core/frame-types.ts";
import { LOKI_TOOLS_SERVER, LokiTools } from "./loki-tools.ts";
import type { AcpAgentConfig } from "./agents.ts";
import { AcpCatalog, selectOptions } from "./catalog.ts";
import { AcpProcess } from "./process.ts";
import { acpTurnProperties } from "../telemetry.ts";

/** How long a page the agent asks the person to open waits for them: Claude Code's own wait for a sign-in. */
const SIGN_IN_WAIT_MS = 10 * 60_000;
/** How long Stop waits for the agent to say it stopped before loki ends the turn without it. */
const STOP_WAIT_MS = 3_000;
/**
 * Chats that run on an ACP agent (plan 020). Each chat has a session on its agent's process; a message is a
 * `session/prompt`, and what the agent reports as it works (`session/update`) becomes loki's chat events for every
 * client and, as each message completes, entries in the chat's own store. So the thread, the Inbox, history and the
 * passes read an ACP chat as they read any other (R7), and the usage the agent reports lands in the usage ledger
 * (R9). The agent's permission requests are loki's approval cards (KD10).
 */

/** What the ACP chats are made with. */
export interface AcpChatsDeps {
  stores: StoreManager;
  approvals: Approvals;
  context: Context;
  /** The ACP agents loki knows (daemon/acp/agents.ts), read on each use so an added agent needs no restart. */
  agents: () => AcpAgentConfig[];
  /** What is added to the agent's system prompt for a loki agent: its persona and memory (KD5); null for nothing. */
  systemPrompt?: (agentId: string, withTools: boolean) => string | null;
  /** The folder a chat with none set runs in. */
  homeDir: string;
  /**
   * The MCP servers a chat's session opens with (plan 044): loki's own tools (daemon/acp/loki-tools.ts) and the
   * servers set up in loki that are on for the agent, which it connects to itself; absent, none. Those over HTTP or SSE go only to an agent that
   * says it takes them.
   */
  mcpServers?: (agentId: string, conversationId: string) => Promise<acp.McpServer[]>;
  /** Opens a web page in this Mac's browser: an MCP server's sign-in the agent asked for (plan 044); absent, none opens. */
  openUrl?: (url: string) => void;
  /** Tools the agent runs without asking (plan 044): those that only read, as Claude Code names them. */
  allowedTools?: (agentId: string) => string[];
  /** loki's tool server limited to a background pass's own tools (plan 061); absent, a pass gets no tools. */
  passServer?: (agentId: string, conversationId: string, tools: readonly string[]) => acp.McpServer | null;
  /** Analytics: each turn's `turn_finished` line (daemon/telemetry.ts); absent, nothing is recorded. */
  capture?: (event: string, properties: Record<string, unknown>) => void;
  /** Where each line the agents write to stderr goes, named by agent, so a hang can be traced; absent, nowhere. */
  report?: (message: string) => void;
  /** How long Stop waits for the agent to answer it, in milliseconds; absent, three seconds. */
  stopWaitMs?: number;
  /** The person's agents file (`state/acp.json`), which Preferences › Engines edits; absent, the agents cannot be edited. */
  configFile?: string;
  /**
   * Where what each agent last offered (its models, modes and commands) is kept, so the model picker and a chat's
   * menus have them before the agent next starts; absent, they are kept only while the daemon runs.
   */
  cacheFile?: string;
  now?: () => Date;
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
  /** What Stop ends: the turn running now, or the session being opened ahead of the first message (`warm`). */
  stop: AbortController | null;
  queue: Promise<void>;
  sent: Set<string>;
  modes: acp.SessionModeState | null;
  configOptions: acp.SessionConfigOption[];
  commands: acp.AvailableCommand[];
  /** The agent's running total of dollars for the session (it reports the total, not each turn's). */
  costSoFar: number;
  /**
   * A background pass's hidden chat (plan 061): its session opens with the job's instructions and only the job's
   * tools, and every permission the agent asks for is refused without a card.
   */
  pass: { instructions: string; tools: readonly string[] } | null;
}

/** What one turn came to: the agent's last words, and why it failed or null. */
interface TurnOutcome {
  text: string;
  error: string | null;
}

/** What a background pass asks of an ACP agent (plan 061), in a hidden chat of its own. */
export interface PassRun {
  agentId: string;
  /** The pass's hidden chat, made on first use. */
  chatId: string;
  title: string;
  engine: ChatEngine;
  /** The folder the session runs in: the agent's memory, so what the agent reads without asking is the pass's own. */
  cwd: string;
  instructions: string;
  /** loki's tools the job may call, by loki's names; empty for none. */
  tools: readonly string[];
  prompt: string;
  /** How long the turn may take before it is stopped and the run fails. */
  timeoutMs: number;
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

/** Thrown when Stop ended the wait on the agent: it did not answer in time. */
class Stopped extends Error {}

/**
 * The agent's answer, unless Stop comes first and the agent has not answered `waitMs` later: a stuck agent cannot keep
 * a chat busy, and one that stops when asked still says its last words.
 */
function unlessStopped<T>(work: Promise<T>, signal: AbortSignal, waitMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stopped = () => {
      timer = setTimeout(() => reject(new Stopped("the agent did not stop when asked")), waitMs);
    };
    if (signal.aborted) stopped();
    else signal.addEventListener("abort", stopped, { once: true });
    work.then(resolve, reject).finally(() => {
      clearTimeout(timer);
      signal.removeEventListener("abort", stopped);
    });
  });
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
  /** Who waits for a session to be registered: a sign-in it asks for while it opens (see `elicit`). */
  private readonly registering = new Map<string, Array<(live: Live) => void>>();
  private readonly processes = new Map<string, AcpProcess>();
  /** The agents loki knows, how each stands, and what each offered (daemon/acp/catalog.ts). */
  private readonly catalog: AcpCatalog;
  /** How long Stop waits for the agent to answer it. */
  private readonly stopWaitMs: number;
  private readonly deps: AcpChatsDeps;

  constructor(deps: AcpChatsDeps) {
    this.deps = deps;
    this.stopWaitMs = deps.stopWaitMs ?? STOP_WAIT_MS;
    this.catalog = new AcpCatalog({ agents: deps.agents, configFile: deps.configFile, cacheFile: deps.cacheFile });
  }

  /** Tell the catalog what a session offers, for the picker and for chats whose agent is not running now. */
  private remember(live: Live): void {
    const known = this.catalog.offeredBy(live.agent);
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
    this.catalog.offer(live.agent, {
      models: selectOptions(modelOption),
      modes: live.modes
        ? live.modes.availableModes.map((m) => ({ id: m.id, name: m.name, description: m.description ?? null }))
        : selectOptions(modeOption).map((o) => ({ id: o.value, name: o.name, description: o.description })),
      commands: live.commands.length
        ? live.commands.map((c) => ({ name: c.name, description: c.description, hint: c.input?.hint ?? null }))
        : (known?.commands ?? []),
      ...(Object.keys(efforts).length ? { efforts } : {}),
    });
  }

  /** Preferences › Engines: every agent, how it starts and how it stands. */
  engines(): EnginesView {
    return this.catalog.engines();
  }

  /** Add an agent, or change how one starts; its process starts again the new way on the next message. */
  setEngine(agent: AcpAgentConfig): Promise<EnginesView> {
    this.catalog.set(agent);
    this.restart(agent.id);
    return Promise.resolve(this.catalog.engines());
  }

  /** Remove an agent; a built-in one goes back to how loki ships it. */
  removeEngine(id: string): Promise<EnginesView> {
    this.catalog.remove(id);
    this.restart(id);
    return Promise.resolve(this.catalog.engines());
  }

  /** Start an agent afresh and initialize it, to see that it starts; sign-in shows only on a first message. */
  async checkEngine(id: string): Promise<EnginesView> {
    const proc = this.process(id);
    await proc.close();
    try {
      await proc.capabilities();
      if (this.catalog.healthOf(id)?.status !== "ready") this.catalog.went(id, { status: "started", detail: "it starts; sign-in shows on the first message" });
    } catch (error) {
      this.catalog.went(id, { status: "failed", detail: proc.failure(error).message });
    }
    return this.catalog.engines();
  }

  /** The agent's process goes, so the next message starts it as its settings now say. */
  private restart(id: string): void {
    void this.processes.get(id)?.close();
    this.processes.delete(id);
  }

  /** The chat's engine as the app shows it: the agent's name, the model, and its modes and commands. */
  view(engine: Pick<ChatEngine, "agent" | "model">): ChatEngineView {
    return this.catalog.view(engine);
  }

  /** Tell every client the chat's engine changed (its modes or commands arrived), and its mode when that is known. */
  private pushView(live: Live, engine: Pick<ChatEngine, "agent" | "model">, mode?: string): void {
    const view = this.catalog.view(engine);
    this.push(live.agentId, live.conversationId, [{ kind: "device", engine: view, ...(mode ? { mode } : {}) }]);
  }

  /** The mode the agent's session is in now: its mode state, or its mode option. */
  private currentMode(live: Live): string | null {
    if (live.modes) return live.modes.currentModeId;
    const option = live.configOptions.find((o) => o.category === "mode");
    return option?.type === "select" ? option.currentValue : null;
  }

  /** Each ACP agent's models for the model picker (AcpCatalog.models). */
  models(): ModelEntry[] {
    return this.catalog.models();
  }

  attach(push: (agentId: string, conversationId: string, events: ChatEvent[]) => void): void {
    this.push = push;
  }

  private now(): string {
    return (this.deps.now?.() ?? new Date()).toISOString();
  }

  /** The agent named `id`, if loki knows it. */
  agent(id: string): AcpAgentConfig | undefined {
    return this.catalog.agent(id);
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
        elicit: (r) => this.elicit(r),
        log: (line) => this.deps.report?.(`${agent}: ${line}`),
      });
      this.processes.set(agent, proc);
    }
    return proc;
  }

  private liveOf(agentId: string, conversationId: string, engine: ChatEngine): Live {
    let live = this.live.get(key(agentId, conversationId));
    // Moved to another agent before its first message, after its session was opened early (`warm`): start over.
    if (live && live.agent !== engine.agent && !live.turn) {
      if (live.sessionId) this.bySession.delete(live.sessionId);
      live = undefined;
    }
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
        stop: null,
        queue: Promise.resolve(),
        sent: new Set(),
        modes: null,
        configOptions: [],
        commands: [],
        costSoFar: 0,
        pass: null,
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
      engine: info.engine?.kind === "acp" ? this.view(info.engine) : null,
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

  /**
   * Open the chat's session now, ahead of its first message, so the agent says which models and effort levels it
   * offers before anything is sent (plan 021, R4) and the first message starts sooner. Queued like a turn; a failure
   * here is left for the first message to report.
   */
  warm(agentId: string, conversationId: string, engine: ChatEngine): void {
    const live = this.liveOf(agentId, conversationId, engine);
    live.queue = live.queue
      .then(async () => {
        // Stop ends the wait too: an agent that never finishes opening must not hold the messages queued behind it.
        const stop = new AbortController();
        live.stop = stop;
        try {
          const { store, chat, info } = await this.chat(agentId, conversationId);
          if (info.engine?.kind === "acp" && info.engine.agent === live.agent)
            await unlessStopped(this.session(live, store, chat, info, info.engine), stop.signal, this.stopWaitMs);
        } finally {
          if (live.stop === stop) live.stop = null;
        }
      })
      .catch(() => {});
  }

  /** A message from loki itself (a schedule's prompt, a background task's notice): queued like the person's. */
  deliver(agentId: string, conversationId: string, text: string, engine: ChatEngine): void {
    this.enqueue(this.liveOf(agentId, conversationId, engine), text, []);
  }

  private enqueue(live: Live, text: string, images: PayloadOf<"chat_send">["images"]): void {
    live.queue = live.queue
      .then(() => this.run(live, text, images))
      .then(() => {})
      .catch(() => {});
  }

  /**
   * A background pass on an ACP agent (plan 061): its hidden chat, made on first use in the agent's memory folder and
   * put on the engine given, starts a new session each run, with the job's instructions and only its tools, and the
   * agent's last words come back. A run past `timeoutMs` is stopped and fails, as one on loki's engine does.
   */
  async runPass(p: PassRun): Promise<string> {
    const { context } = this.deps;
    const store = await this.deps.stores.get(p.agentId);
    if (!(await store.chat(p.chatId, context))) await store.createChat(p.chatId, { title: p.title, hidden: true, agent: { cwd: p.cwd } }, context);
    const engine: ChatEngine = { ...p.engine, session_id: null };
    await store.updateChat(p.chatId, { engine }, context);
    const live = this.liveOf(p.agentId, p.chatId, engine);
    // A new session each run, as a pass chat on loki's engine is cleared first: nothing carries over between runs.
    if (live.sessionId) this.bySession.delete(live.sessionId);
    live.sessionId = null;
    live.agent = engine.agent;
    live.model = engine.model;
    live.effort = engine.effort ?? null;
    live.pass = { instructions: p.instructions, tools: p.tools };
    const ran = live.queue.then(() => this.run(live, p.prompt, []));
    live.queue = ran.then(
      () => {},
      () => {},
    );
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        this.abort(p.agentId, p.chatId);
        reject(new Error(`the pass did not finish within ${Math.round(p.timeoutMs / 1000)}s`));
      }, p.timeoutMs);
    });
    try {
      const outcome = await Promise.race([ran, late]);
      if (outcome.error) throw new Error(`the pass did not finish: ${outcome.error}`);
      return outcome.text;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Stop the turn running now, or the session being opened for the first message: what waits on the person is
   * withdrawn and the agent is asked to cancel. The chat is free again once the agent answers, or `STOP_WAIT_MS` later
   * if it does not; the messages queued behind it then go.
   */
  abort(agentId: string, conversationId: string): void {
    const live = this.live.get(key(agentId, conversationId));
    if (!live?.stop) return;
    live.stop.abort();
    // Not awaited: an agent stuck starting would hold Stop itself.
    if (live.sessionId)
      void this.process(live.agent)
        .cancel(live.sessionId)
        .catch(() => {});
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
    const takesPrompt = Boolean(caps.sessionCapabilities?.systemPrompt);
    const pass = live.pass;
    const servers = pass
      ? [this.deps.passServer && pass.tools.length ? this.deps.passServer(live.agentId, live.conversationId, pass.tools) : null].filter((m) => m !== null)
      : this.deps.mcpServers
        ? await this.deps.mcpServers(live.agentId, live.conversationId)
        : [];
    const mcpServers = servers.filter((m) =>
      !("type" in m) ? true : m.type === "http" ? Boolean(caps.mcpCapabilities?.http) : m.type === "sse" ? Boolean(caps.mcpCapabilities?.sse) : false,
    );
    const prompt = pass
      ? pass.instructions
      : (this.deps.systemPrompt?.(
          live.agentId,
          mcpServers.some((m) => m.name === LOKI_TOOLS_SERVER),
        ) ?? null);
    const systemPrompt = prompt && takesPrompt ? { systemPrompt: { mode: "append" as const, content: [{ type: "text" as const, text: prompt }] } } : {};
    const allowedTools = pass ? LokiTools.named(pass.tools) : (this.deps.allowedTools?.(live.agentId) ?? []);
    // Claude's adapter takes the tools it may run without asking as one of its options; another agent ignores it.
    const meta = allowedTools.length ? { _meta: { claudeCode: { options: { allowedTools } } } } : {};
    const opening = { cwd, mcpServers, ...systemPrompt, ...meta };
    if (live.sessionId) this.bySession.delete(live.sessionId);
    let opened: { sessionId: string; modes?: acp.SessionModeState | null; configOptions?: acp.SessionConfigOption[] | null } | null = null;
    if (engine.session_id && caps.loadSession) {
      live.sessionId = engine.session_id;
      this.bySession.set(engine.session_id, live);
      live.loading = true;
      try {
        opened = { sessionId: engine.session_id, ...(await proc.loadSession({ sessionId: engine.session_id, ...opening })) };
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
      opened = await proc.newSession(opening);
      // Known before anything else is awaited: the agent sends its commands right after it answers.
      this.register(opened.sessionId, live);
      // Only while the chat is still on this agent: one opened early may have moved on while the agent started.
      const now = (await store.chatInfo(chat.id, this.deps.context))?.engine;
      if (now?.kind === "acp" && now.agent === engine.agent)
        await store.updateChat(live.conversationId, { engine: { ...now, session_id: opened.sessionId } }, this.deps.context);
    }
    live.sessionId = opened.sessionId;
    live.epoch = proc.epoch();
    live.modes = opened.modes ?? null;
    live.configOptions = opened.configOptions ?? [];
    live.preamble = prompt && !takesPrompt ? prompt : null;
    this.register(opened.sessionId, live);
    // The chat's latest choice: a session opened early may have been asked for another while the agent started.
    await this.applyModel(live, live.model);
    await this.applyEffort(live, live.effort);
    this.remember(live);
    // The chat's mode, when it is one of the agent's; otherwise the chat takes the mode the agent is in. Read again
    // now: it may have been chosen while the agent started.
    const wanted = (await store.chatInfo(chat.id, this.deps.context))?.mode ?? info.mode;
    const offered = this.catalog.offeredBy(live.agent)?.modes ?? [];
    if (wanted && offered.some((m) => m.id === wanted)) await this.applyMode(live, wanted).catch(() => {});
    const mode = this.currentMode(live);
    if (mode && mode !== wanted) await store.updateChat(live.conversationId, { mode }, this.deps.context);
    this.pushView(live, engine, mode ?? undefined);
    return opened.sessionId;
  }

  /**
   * One turn: the message written and shown, sent to the agent, and the chat settled when it answers or fails. What it
   * comes to: the agent's last words, and why it failed or null; a background pass reads both (plan 061).
   */
  private async run(live: Live, text: string, images: PayloadOf<"chat_send">["images"]): Promise<TurnOutcome> {
    const { store, chat, info } = await this.chat(live.agentId, live.conversationId);
    if (info.engine?.kind !== "acp") return { text: "", error: "the chat is not on an ACP agent" };
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
    live.stop = turn.abort;
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
    const outcome: TurnOutcome = { text: "", error: null };
    try {
      const sessionId = await unlessStopped(this.session(live, store, chat, info, info.engine), turn.abort.signal, this.stopWaitMs);
      const caps = await proc.capabilities();
      const prompt: acp.ContentBlock[] = [
        ...(live.preamble ? [{ type: "text" as const, text: `<loki-agent>\n${live.preamble}\n</loki-agent>` }] : []),
        ...(text ? [{ type: "text" as const, text }] : []),
        ...(caps.promptCapabilities?.image ? images.map((i) => ({ type: "image" as const, data: i.data, mimeType: i.media_type })) : []),
      ];
      live.preamble = null;
      if (images.length && !caps.promptCapabilities?.image)
        this.push(live.agentId, live.conversationId, [{ kind: "error", message: "this agent takes no pictures; they were not sent" }]);
      const response = await unlessStopped(proc.prompt({ sessionId, prompt }), turn.abort.signal, this.stopWaitMs);
      usage = response.usage ?? null;
      stopReason = response.stopReason;
      outcome.text = await this.finish(live, store, chat, turn, usage, info.engine);
      if (response.stopReason !== "end_turn") outcome.error = stopNote(response.stopReason) ?? `the agent stopped: ${response.stopReason}`;
      this.catalog.went(live.agent, { status: "ready", detail: null });
      const note = stopNote(response.stopReason);
      if (note) this.push(live.agentId, live.conversationId, [{ kind: "error", message: note }]);
    } catch (error) {
      await this.finish(live, store, chat, turn, null, info.engine).catch(() => {});
      if (error instanceof Stopped) {
        // The agent may still be working on it; the chat no longer waits.
        stopReason = "cancelled";
        outcome.error = "the turn was stopped";
        this.push(live.agentId, live.conversationId, [{ kind: "error", message: "the agent did not answer the stop, so loki ended the turn without it" }]);
        return outcome;
      }
      const message = proc.failure(error).message;
      outcome.error = message;
      this.catalog.went(live.agent, { status: "failed", detail: message.split("\n")[0] });
      this.push(live.agentId, live.conversationId, [{ kind: "error", message }]);
    } finally {
      live.turn = null;
      if (live.stop === turn.abort) live.stop = null;
      this.push(live.agentId, live.conversationId, [{ kind: "settle" }, { kind: "loop", state: "idle" }, { kind: "turn_end", turn_id: turn.id }]);
      this.measure(live, turn, info.engine, usage, stopReason);
    }
    return outcome;
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

  /** The end of a turn: calls left open fail, the plan and the last words are written, and the usage counted; the words. */
  private async finish(live: Live, store: AgentStore, chat: Conversation, turn: Turn, usage: acp.Usage | null, engine: ChatEngine): Promise<string> {
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
    return words;
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
    for (const waiting of this.registering.get(sessionId) ?? []) waiting(live);
    this.registering.delete(sessionId);
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
   * The agent asks the person to open a page (plan 044): Claude Code's sign-in to an MCP server, whose answer comes
   * back to a listener Claude Code runs on this Mac. A loki card asks first, in the chat, on the Mac and the phone;
   * allowed, the page opens in this Mac's browser wherever the card was answered. Claude Code keeps the token for
   * every later session, so each server asks once. A form, or a page that is not a web address, is declined; the card
   * waits as long as the agent does (ten minutes).
   */
  private async elicit(r: acp.CreateElicitationRequest): Promise<acp.CreateElicitationResponse> {
    // The request's type keeps room for modes a later ACP adds, so its fields are read as unknown and checked.
    const url = r.mode === "url" && "url" in r && typeof r.url === "string" && /^https?:\/\//i.test(r.url) ? r.url : null;
    const sessionId = "sessionId" in r && typeof r.sessionId === "string" ? r.sessionId : null;
    const openUrl = this.deps.openUrl;
    if (!url || !sessionId || !openUrl) return { action: "decline" };
    const signal = AbortSignal.timeout(SIGN_IN_WAIT_MS);
    const live = await this.sessionLive(sessionId, signal);
    if (!live) return { action: "cancel" };
    const event = { kind: "approval" as const, request_id: `acp-page-${randomUUID()}`, tool_name: r.message, input: { url } };
    try {
      const d = await this.deps.approvals.ask<{ allow: boolean }>(live.agentId, live.conversationId, event, signal, { remember: false });
      if (!d.allow) return { action: "decline" };
      openUrl(url);
      return { action: "accept" };
    } catch {
      return { action: "cancel" };
    }
  }

  /** The chat a session belongs to, waiting for it to be registered when the agent asks before `session/new` answers. */
  private sessionLive(sessionId: string, signal: AbortSignal): Promise<Live | null> {
    const known = this.bySession.get(sessionId);
    if (known) return Promise.resolve(known);
    return new Promise((resolve) => {
      const waiting = (live: Live) => resolve(live);
      this.registering.set(sessionId, [...(this.registering.get(sessionId) ?? []), waiting]);
      signal.addEventListener("abort", () => {
        this.registering.set(
          sessionId,
          (this.registering.get(sessionId) ?? []).filter((w) => w !== waiting),
        );
        resolve(null);
      });
    });
  }

  /**
   * The agent asks before a tool call: a loki approval card with the agent's own choices behind it. Allow picks its
   * "allow once" (or "always allow" when the person ticked always), deny its "reject once"; a stopped turn answers
   * cancelled, as ACP asks.
   */
  private async permission(r: acp.RequestPermissionRequest): Promise<acp.RequestPermissionResponse> {
    const live = this.bySession.get(r.sessionId);
    if (!live?.turn) return { outcome: { outcome: "cancelled" } };
    // A pass has no one to ask: whatever the agent would do beyond its job's tools is refused (plan 061).
    if (live.pass) {
      const reject = r.options.find((o) => o.kind === "reject_once") ?? r.options.find((o) => o.kind === "reject_always");
      return reject ? { outcome: { outcome: "selected", optionId: reject.optionId } } : { outcome: { outcome: "cancelled" } };
    }
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
