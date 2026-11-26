import type { Context } from "@earendil-works/chord";
import type { Conversation } from "@earendil-works/pi-durable";
import type * as acp from "@agentclientprotocol/sdk";
import { randomUUID } from "node:crypto";
import { contentText } from "../../core/harness.ts";
import type { ChatEvent } from "../../core/attention/model.ts";
import type { ChatState, PayloadOf } from "../../core/frames.ts";
import type { ChatEngineView, ModelEntry } from "../../core/models.ts";
import type { Approvals } from "../approvals.ts";
import { AgentInfoDoc, type AgentStore, type ChatEngine, type ChatInfo } from "../kernel/index.ts";
import type { StoreManager } from "../kernel/stores.ts";
import type { EnginesView } from "../../core/frame-types.ts";
import { LOKI_TOOLS_SERVER, LokiTools } from "./loki-tools.ts";
import type { AcpAgentConfig } from "./agents.ts";
import { AcpCatalog, selectOptions } from "./catalog.ts";
import { AcpProcess } from "./process.ts";
import type { ModRegistry } from "../mods/registry.ts";
import { Stopped, applySessionNotification, finishTurn, stopNote, unlessStopped, type Live, type StreamHost, type Turn, type TurnOutcome } from "./stream.ts";

const SIGN_IN_WAIT_MS = 10 * 60_000;
const STOP_WAIT_MS = 3_000;

export interface AcpChatsDeps {
  stores: StoreManager;
  approvals: Approvals;
  context: Context;
  agents: () => AcpAgentConfig[];
  systemPrompt?: (agentId: string, withTools: boolean) => string | null;
  mods?: Pick<ModRegistry, "renderSections" | "transformMessage">;
  homeDir: string;
  mcpServers?: (agentId: string, conversationId: string) => Promise<acp.McpServer[]>;
  openUrl?: (url: string) => void;
  allowedTools?: (agentId: string) => string[];
  passServer?: (agentId: string, conversationId: string, tools: readonly string[]) => acp.McpServer | null;
  report?: (message: string) => void;
  stopWaitMs?: number;
  configFile?: string;
  cacheFile?: string;
  now?: () => Date;
}

export interface PassRun {
  agentId: string;
  chatId: string;
  title: string;
  engine: ChatEngine;
  cwd: string;
  instructions: string;
  tools: readonly string[];
  prompt: string;
  timeoutMs: number;
}

const key = (agentId: string, conversationId: string) => `${agentId}\u0000${conversationId}`;

export class AcpChats {
  private push: (agentId: string, conversationId: string, events: ChatEvent[]) => void = () => {};
  private readonly live = new Map<string, Live>();
  private readonly bySession = new Map<string, Live>();
  /** Updates for a session loki has not registered yet (they can arrive with its `session/new` answer), replayed once it has. */
  private readonly early = new Map<string, acp.SessionNotification[]>();
  private readonly registering = new Map<string, Array<(live: Live) => void>>();
  private readonly processes = new Map<string, AcpProcess>();
  private readonly catalog: AcpCatalog;
  private readonly stopWaitMs: number;
  private readonly deps: AcpChatsDeps;

  constructor(deps: AcpChatsDeps) {
    this.deps = deps;
    this.stopWaitMs = deps.stopWaitMs ?? STOP_WAIT_MS;
    this.catalog = new AcpCatalog({ agents: deps.agents, configFile: deps.configFile, cacheFile: deps.cacheFile });
  }

  private streamHost(): StreamHost {
    return {
      context: this.deps.context,
      now: () => this.now(),
      push: (agentId, conversationId, events) => this.push(agentId, conversationId, events),
      view: (engine) => this.view(engine),
      chat: (agentId, conversationId) => this.chat(agentId, conversationId),
      saveMode: async (agentId, conversationId, modeId) => {
        const store = await this.deps.stores.get(agentId);
        await store.updateChat(conversationId, { mode: modeId }, this.deps.context);
      },
      remember: (live) => this.remember(live),
    };
  }

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

  engines(): EnginesView {
    return this.catalog.engines();
  }

  setEngine(agent: AcpAgentConfig): Promise<EnginesView> {
    this.catalog.set(agent);
    this.restart(agent.id);
    return Promise.resolve(this.catalog.engines());
  }

  removeEngine(id: string): Promise<EnginesView> {
    this.catalog.remove(id);
    this.restart(id);
    return Promise.resolve(this.catalog.engines());
  }

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

  private restart(id: string): void {
    void this.processes.get(id)?.close();
    this.processes.delete(id);
  }

  view(engine: Pick<ChatEngine, "agent" | "model">): ChatEngineView {
    return this.catalog.view(engine);
  }

  private pushView(live: Live, engine: Pick<ChatEngine, "agent" | "model">, mode?: string): void {
    const view = this.catalog.view(engine);
    this.push(live.agentId, live.conversationId, [{ kind: "device", engine: view, ...(mode ? { mode } : {}) }]);
  }

  private currentMode(live: Live): string | null {
    if (live.modes) return live.modes.currentModeId;
    const option = live.configOptions.find((o) => o.category === "mode");
    return option?.type === "select" ? option.currentValue : null;
  }

  models(): ModelEntry[] {
    return this.catalog.models();
  }

  attach(push: (agentId: string, conversationId: string, events: ChatEvent[]) => void): void {
    this.push = push;
  }

  private now(): string {
    return (this.deps.now?.() ?? new Date()).toISOString();
  }

  agent(id: string): AcpAgentConfig | undefined {
    return this.catalog.agent(id);
  }

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
        epoch: null,
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

  busy(agentId: string, conversationId: string): boolean {
    return Boolean(this.live.get(key(agentId, conversationId))?.turn) || this.deps.approvals.waitingIn(agentId, conversationId).length > 0;
  }

  async state(agentId: string, conversationId: string): Promise<ChatState> {
    const { store, chat, info } = await this.chat(agentId, conversationId);
    const live = this.live.get(key(agentId, conversationId));
    // oxlint-disable-next-line typescript/no-unnecessary-type-assertion -- tsgolint 7.0.2005 calls this a no-op, but tsc needs it: agentSettings returns object, which has no fields to read.
    const settings = (await store.agentSettings(chat.id, this.deps.context)) as { cwd?: string } | undefined;
    const waiting = this.deps.approvals.waitingIn(agentId, conversationId).length > 0;
    const turn = live?.turn ?? null;
    return {
      agent_id: agentId,
      conversation_id: conversationId,
      loop: waiting ? "approval" : turn ? "running" : "idle",
      mode: info.mode ?? live?.modes?.currentModeId ?? null,
      cwd: settings?.cwd ?? null,
      engine: info.engine?.kind === "acp" ? this.view(info.engine) : null,
      ...(turn?.text ? { streaming: { text: turn.text, at: turn.at } } : {}),
    };
  }

  send(p: PayloadOf<"chat_send">, engine: ChatEngine): void {
    const live = this.liveOf(p.agent_id, p.conversation_id, engine);
    if (p.send_id) {
      if (live.sent.has(p.send_id)) return;
      live.sent.add(p.send_id);
    }
    const text = [p.context, p.text.trim() ? p.text : null].filter((t): t is string => Boolean(t)).join("\n\n");
    this.enqueue(live, text, p.images, { typed: p.text.trim() !== "" });
  }

  warm(agentId: string, conversationId: string, engine: ChatEngine): void {
    const live = this.liveOf(agentId, conversationId, engine);
    live.queue = live.queue
      .then(async () => {
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

  deliver(agentId: string, conversationId: string, text: string, engine: ChatEngine): void {
    this.enqueue(this.liveOf(agentId, conversationId, engine), text, []);
  }

  private enqueue(live: Live, text: string, images: PayloadOf<"chat_send">["images"], person?: { typed: boolean }): void {
    live.queue = live.queue
      .then(() => this.run(live, text, images, person))
      .then(() => {})
      .catch(() => {});
  }

  async runPass(p: PassRun): Promise<string> {
    const { context } = this.deps;
    const store = await this.deps.stores.get(p.agentId);
    if (!(await store.chat(p.chatId, context))) await store.createChat(p.chatId, { title: p.title, hidden: true, agent: { cwd: p.cwd } }, context);
    const engine: ChatEngine = { ...p.engine, session_id: null };
    await store.updateChat(p.chatId, { engine }, context);
    const live = this.liveOf(p.agentId, p.chatId, engine);
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

  abort(agentId: string, conversationId: string): void {
    const live = this.live.get(key(agentId, conversationId));
    if (!live?.stop) return;
    live.stop.abort();
    if (live.sessionId)
      void this.process(live.agent)
        .cancel(live.sessionId)
        .catch(() => {});
  }

  async setMode(agentId: string, conversationId: string, modeId: string): Promise<void> {
    const { store } = await this.chat(agentId, conversationId);
    await store.updateChat(conversationId, { mode: modeId }, this.deps.context);
    const live = this.live.get(key(agentId, conversationId));
    if (live?.sessionId && live.epoch === this.process(live.agent).epoch()) await this.applyMode(live, modeId);
    this.push(agentId, conversationId, [{ kind: "device", mode: modeId }]);
  }

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

  commands(agentId: string, conversationId: string): acp.AvailableCommand[] {
    return this.live.get(key(agentId, conversationId))?.commands ?? [];
  }

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

  private async applyEffort(live: Live, effort: string | null): Promise<void> {
    if (!live.sessionId || !effort) return;
    const option = live.configOptions.find((o) => o.category === "thought_level" && o.type === "select");
    if (option?.type !== "select" || option.currentValue === effort || !selectOptions(option).some((o) => o.value === effort)) return;
    live.configOptions = (await this.process(live.agent).setConfigOption(live.sessionId, option.id, effort)).configOptions;
  }

  private async session(live: Live, store: AgentStore, chat: Conversation, info: Readonly<ChatInfo>, engine: ChatEngine): Promise<string> {
    const proc = this.process(live.agent);
    const caps = await proc.capabilities();
    if (live.sessionId && live.epoch === proc.epoch()) return live.sessionId;
    // oxlint-disable-next-line typescript/no-unnecessary-type-assertion -- tsgolint 7.0.2005 calls this a no-op, but tsc needs it: agentSettings returns object, which has no fields to read.
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
      : [
          this.deps.systemPrompt?.(
            live.agentId,
            mcpServers.some((m) => m.name === LOKI_TOOLS_SERVER),
          ),
          ...((await this.deps.mods?.renderSections({ chatId: live.conversationId, agentId: live.agentId, agentName: await this.agentName(store), cwd })) ??
            []),
        ]
          .filter(Boolean)
          .join("\n\n") || null;
    const systemPrompt = prompt && takesPrompt ? { systemPrompt: { mode: "append" as const, content: [{ type: "text" as const, text: prompt }] } } : {};
    const allowedTools = pass ? LokiTools.named(pass.tools) : (this.deps.allowedTools?.(live.agentId) ?? []);
    // Outside (Claude Code): its ACP adapter takes the tools it may run without asking as one of its options; another agent ignores it.
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
      // Outside (ACP): the agent sends its commands right after it answers, so the session is known before anything else is awaited.
      this.register(opened.sessionId, live);
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
    await this.applyModel(live, live.model);
    await this.applyEffort(live, live.effort);
    this.remember(live);
    const wanted = (await store.chatInfo(chat.id, this.deps.context))?.mode ?? info.mode;
    const offered = this.catalog.offeredBy(live.agent)?.modes ?? [];
    if (wanted && offered.some((m) => m.id === wanted)) await this.applyMode(live, wanted).catch(() => {});
    const mode = this.currentMode(live);
    if (mode && mode !== wanted) await store.updateChat(live.conversationId, { mode }, this.deps.context);
    this.pushView(live, engine, mode ?? undefined);
    return opened.sessionId;
  }

  private async agentName(store: AgentStore): Promise<string> {
    return (await store.harness.snapshot(AgentInfoDoc, this.deps.context))?.name ?? "";
  }

  private async transformed(live: Live, store: AgentStore, text: string, typed: boolean): Promise<string> {
    const mods = this.deps.mods;
    if (!mods) return text;
    const content = mods.transformMessage({ chatId: live.conversationId, agentId: live.agentId, agentName: await this.agentName(store), content: text, typed });
    if (typeof content === "string") return content;
    return content.flatMap((p) => (p.type === "text" && typeof p.text === "string" ? [p.text] : [])).join("\n\n");
  }

  private async run(live: Live, sent: string, images: PayloadOf<"chat_send">["images"], person?: { typed: boolean }): Promise<TurnOutcome> {
    const { store, chat, info } = await this.chat(live.agentId, live.conversationId);
    if (info.engine?.kind !== "acp") return { text: "", error: "the chat is not on an ACP agent" };
    const text = person ? await this.transformed(live, store, sent, person.typed) : sent;
    const proc = this.process(live.agent);
    const turn: Turn = {
      id: `acp-${randomUUID()}`,
      abort: new AbortController(),
      text: "",
      thought: "",
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
      { kind: "loop", state: "running" },
      { kind: "step", step: { kind: "user", raw: contentText(content), at } },
    ]);
    let usage: acp.Usage | null = null;
    const outcome: TurnOutcome = { text: "", error: null };
    try {
      await store.appendEntries(chat, [{ kind: "pi.user", message: { role: "user", content, timestamp: Date.parse(at) } }], null, this.deps.context);
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
      outcome.text = await finishTurn(this.streamHost(), live, store, chat, turn, usage, info.engine);
      if (response.stopReason !== "end_turn") outcome.error = stopNote(response.stopReason) ?? `the agent stopped: ${response.stopReason}`;
      this.catalog.went(live.agent, { status: "ready", detail: null });
      const note = stopNote(response.stopReason);
      if (note) this.push(live.agentId, live.conversationId, [{ kind: "error", message: note }]);
    } catch (error) {
      await finishTurn(this.streamHost(), live, store, chat, turn, null, info.engine).catch(() => {});
      if (error instanceof Stopped) {
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
      this.push(live.agentId, live.conversationId, [{ kind: "settle" }, { kind: "loop", state: "idle" }, { kind: "turn_end" }]);
    }
    return outcome;
  }

  private register(sessionId: string, live: Live): void {
    if (this.bySession.get(sessionId) === live) return;
    this.bySession.set(sessionId, live);
    for (const waiting of this.registering.get(sessionId) ?? []) waiting(live);
    this.registering.delete(sessionId);
    const early = this.early.get(sessionId) ?? [];
    this.early.delete(sessionId);
    for (const n of early) this.update(n);
  }

  private update(n: acp.SessionNotification): void {
    const live = this.bySession.get(n.sessionId);
    if (!live) {
      const held = this.early.get(n.sessionId) ?? [];
      if (held.length < 20) this.early.set(n.sessionId, [...held, n]);
      if (this.early.size > 8) this.early.delete(this.early.keys().next().value ?? "");
      return;
    }
    applySessionNotification(this.streamHost(), live, n);
  }

  private async elicit(r: acp.CreateElicitationRequest): Promise<acp.CreateElicitationResponse> {
    // Outside (ACP): the request's type keeps room for modes a later version adds, so its fields are read as unknown and checked.
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

  private async permission(r: acp.RequestPermissionRequest): Promise<acp.RequestPermissionResponse> {
    const live = this.bySession.get(r.sessionId);
    if (!live?.turn) return { outcome: { outcome: "cancelled" } };
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
