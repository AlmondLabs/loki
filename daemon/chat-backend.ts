import type { Context } from "@earendil-works/chord";
import type { Models } from "@earendil-works/pi-ai/models";
import { LiveDoc, watchEvents, type Conversation } from "@earendil-works/pi-durable";
import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync, symlinkSync, unlinkSync } from "node:fs";
import { basename, join } from "node:path";
import { globalSkillsDir } from "../mod/skills.ts";
import type { ChatEvent } from "../core/attention/model.ts";
import { backendName } from "../core/desk-core.ts";
import type { ChatState, PayloadOf } from "../core/frames.ts";
import type { EnginesView, McpView } from "../core/frame-types.ts";
import type { ModelEntry, ReasoningEffort } from "../core/models.ts";
import { readLocalAgent } from "../mod/agents.ts";
import type { ChatBackend } from "../mod/frames/chat.ts";
import { ChatEventConverter } from "./chat-events.ts";
import { turnIdOf } from "./telemetry.ts";
import { piHandle } from "./model-handle.ts";
import { isPermissionMode, type Approvals } from "./approvals.ts";
import type { ImportReport, ImportStatus } from "./import/letta.ts";
import type { Providers } from "./providers.ts";
import type { PassRunner } from "./passes.ts";
import type { McpTools } from "./mcp/index.ts";
import type { PassState } from "./passes-state.ts";
import { editMemoryFile, revertMemoryCommit } from "./memory.ts";
import type { AgentStore, ChatEngine } from "./kernel/index.ts";
import { acpHandle } from "./acp/agents.ts";
import type { AcpChats } from "./acp/chats.ts";
import type { StoreManager } from "./kernel/stores.ts";
import type { ModRegistry } from "./mods/registry.ts";
import { createAgent, listAgents, writeRecord } from "./store/agents.ts";

/**
 * Chats on loki's daemon, as the mod's chat frames ask for them (plan 017, U5; mod/frames/chat.ts). A chat a client
 * opens is followed through pi-durable's event stream, converted to loki's chat events and pushed to every socket.
 * The person's message passes through every mod's transform before it is sent (loki's own adds what you did on the
 * canvas), and a message sent while the chat is busy waits its turn.
 */

interface Deps {
  stores: StoreManager;
  approvals: Approvals;
  providers: Providers;
  /** The background passes (daemon/passes.ts): reflection and Learn. Absent in tests that run none. */
  passes?: { runner: PassRunner; state: PassState };
  /** MCP (daemon/mcp/): each chat's filter is set before it runs and emptied by /clear and a compaction; Settings edits it. */
  mcp?: McpTools;
  mods: ModRegistry;
  models: Models;
  /** Chats on ACP agents (daemon/acp/, plan 020); absent in tests that run none. */
  acp?: AcpChats;
  /** The daemon's agents, in Letta's backend layout (daemon/store/agents.ts). */
  backendDir: string;
  context: Context;
  report?: (message: string) => void;
  /** The import from Letta (daemon/import/letta.ts); absent in tests that do not import. */
  importLetta?: () => Promise<ImportReport>;
  importStatus?: () => ImportStatus;
}

/** A model handle (`provider/model`) as pi-durable's model reference. */
export function modelRef(handle: string): { provider: string; modelId: string } | undefined {
  const slash = handle.indexOf("/");
  return slash > 0 && slash < handle.length - 1 ? { provider: handle.slice(0, slash), modelId: handle.slice(slash + 1) } : undefined;
}

/**
 * A synchronous answer as the promise ChatBackend asks for: a throw becomes its rejection, as in an async method,
 * so a caller's catch still sees it.
 */
const settled = <T>(work: () => T): Promise<T> => new Promise((resolve) => resolve(work()));

/** loki's reasoning effort as pi's thinking level. */
function thinkingLevel(effort: ReasoningEffort | null): string | undefined {
  if (!effort) return undefined;
  return effort === "none" ? "off" : effort === "max" ? "xhigh" : effort;
}

/**
 * The daemon's ChatBackend: opens, sends to and changes chats in each agent's pi-durable store, and
 * pushes the converted events, the approvals and questions included, to the clients through `attach`'s callback.
 */
export class DaemonChats implements ChatBackend {
  private push: (agentId: string, conversationId: string, events: ChatEvent[]) => void = () => {};
  private readonly watching = new Map<string, Promise<void>>();
  /** Each followed chat's event converter, which knows the answer in flight (open hands it to a late client). */
  private readonly converters = new Map<string, ChatEventConverter>();
  /**
   * The chats known to run on an ACP agent. One opened while it was still on loki's engine is followed through
   * pi-durable, which would turn the messages the ACP side writes into events a second time; its follower drops them.
   */
  private readonly onAcp = new Set<string>();
  private readonly deps: Deps;

  constructor(deps: Deps) {
    this.deps = deps;
    // A store that reopens after a failure has new conversations: what followed the old ones follows again on open.
    deps.stores.onOpen((agentId) => {
      for (const key of [...this.watching.keys()]) if (key.startsWith(`${agentId}\u0000`)) this.watching.delete(key);
    });
  }

  attach(push: (agentId: string, conversationId: string, events: ChatEvent[]) => void): void {
    this.push = push;
    this.deps.approvals.attach(push);
    this.deps.acp?.attach(push);
  }

  /** The chat's engine when it runs on an ACP agent; null on loki's own. */
  private async engine(agentId: string, conversationId: string, store: AgentStore, chat: Conversation): Promise<ChatEngine | null> {
    const info = await store.chatInfo(chat.id, this.deps.context);
    const engine = info?.engine?.kind === "acp" && this.deps.acp ? info.engine : null;
    const key = `${agentId}\u0000${conversationId}`;
    if (engine) this.onAcp.add(key);
    else this.onAcp.delete(key);
    return engine;
  }

  private get acp(): AcpChats {
    if (!this.deps.acp) throw new Error("ACP agents are not running in this daemon");
    return this.deps.acp;
  }

  /** Whether anything has been said in the chat yet: its engine is fixed from the first message (plan 020, KD4). */
  private async started(chat: Conversation): Promise<boolean> {
    const page = await chat.entries({ order: "ascending" }, 50, undefined, this.deps.context);
    return page.items.some((e) => e.kind === "pi.user" || e.kind === "pi.assistant");
  }

  private async chat(agentId: string, conversationId: string): Promise<{ store: AgentStore; chat: Conversation }> {
    const store = await this.deps.stores.get(agentId);
    const chat = await store.chat(conversationId, this.deps.context);
    if (!chat) throw new Error(`no chat ${conversationId} for ${agentId}`);
    return { store, chat };
  }

  async open(agentId: string, conversationId: string, mode: string | null = null): Promise<ChatState> {
    const { store, chat } = await this.chat(agentId, conversationId);
    const engine = await this.engine(agentId, conversationId, store, chat);
    // An ACP chat's modes are its agent's own (KD10), so they are not loki's four.
    if (mode !== null && engine) await this.acp.setMode(agentId, conversationId, mode);
    else if (mode !== null) {
      if (!isPermissionMode(mode)) throw new Error(`not a permission mode: ${mode}`);
      await store.updateChat(conversationId, { mode }, this.deps.context);
    }
    if (!engine) await this.watch(store, chat, agentId, conversationId);
    const state = engine ? await this.acp.state(agentId, conversationId) : await this.state(store, chat, agentId, conversationId);
    // What the chat is waiting on reaches a client that opens it late, after the state it opens with.
    const waiting = this.deps.approvals.waitingIn(agentId, conversationId);
    if (waiting.length) queueMicrotask(() => this.push(agentId, conversationId, waiting));
    return state;
  }

  approve(p: PayloadOf<"chat_approve">): Promise<boolean> {
    return settled(() => this.deps.approvals.decide(p.approval_id, p.allow, p.message ?? undefined, p.always));
  }

  approvals(): Promise<{ always: string[] }> {
    return settled(() => ({ always: this.deps.approvals.always() }));
  }

  setApproval(p: PayloadOf<"chat_approvals_set">): Promise<{ always: string[] }> {
    return settled(() => ({ always: this.deps.approvals.setAlways(p.tool, p.on) }));
  }

  private get mcpTools(): McpTools {
    if (!this.deps.mcp) throw new Error("MCP is not running in this daemon");
    return this.deps.mcp;
  }

  engines(): Promise<EnginesView> {
    return settled(() => this.acp.engines());
  }

  setEngine(p: PayloadOf<"chat_engine_set">): Promise<EnginesView> {
    return this.acp.setEngine(p);
  }

  removeEngine(id: string): Promise<EnginesView> {
    return this.acp.removeEngine(id);
  }

  checkEngine(id: string): Promise<EnginesView> {
    return this.acp.checkEngine(id);
  }

  mcp(): Promise<McpView> {
    return settled(() => this.mcpTools.view());
  }

  mcpServer(p: PayloadOf<"chat_mcp_server">): Promise<McpView> {
    return settled(() => this.mcpTools.setServer(p.entry, p.edit, p.rename ?? undefined));
  }

  mcpAlwaysLoad(p: PayloadOf<"chat_mcp_always_load">): Promise<McpView> {
    return settled(() => this.mcpTools.setAlwaysLoad(p.entry, p.tools));
  }

  mcpRestart(name: string): Promise<McpView> {
    return settled(() => this.mcpTools.restart(name));
  }

  async mcpSignOut(name: string): Promise<McpView> {
    return this.mcpTools.signOut(name);
  }

  async mcpOauthCallback(params: Record<string, string>): Promise<{ ok: boolean; server: string | null; message: string }> {
    if (!this.deps.mcp) return { ok: false, server: null, message: "MCP is not running in this daemon." };
    return this.deps.mcp.finishAuth(params);
  }

  mcpAgent(p: PayloadOf<"chat_mcp_agent">): Promise<McpView> {
    return settled(() => this.mcpTools.setAgentServer(p.agent_id, p.server, p.on));
  }

  async mcpSecret(p: PayloadOf<"chat_mcp_secret">): Promise<{ ref: string }> {
    return { ref: await this.mcpTools.storeSecret(p.name, p.value) };
  }

  answer(p: PayloadOf<"chat_answer">): Promise<boolean> {
    return settled(() => this.deps.approvals.answer(p.question_id, p.input));
  }

  /**
   * Follow a chat, once: from now on its events go to every client. A chat a message goes into is followed too, so a
   * client that opened it before the daemon restarted (and does not open it again) still hears the answer.
   */
  private async watch(store: AgentStore, chat: Conversation, agentId: string, conversationId: string): Promise<void> {
    const key = `${agentId}\u0000${conversationId}`;
    if (!this.watching.has(key)) this.watching.set(key, this.follow(store, chat, agentId, conversationId));
    await this.watching.get(key);
  }

  /** Push every event of a chat from now on. */
  private async follow(store: AgentStore, chat: Conversation, agentId: string, conversationId: string): Promise<void> {
    const stream = await watchEvents(store.harness, chat.id, this.deps.context);
    const converter = new ChatEventConverter(agentId);
    this.converters.set(`${agentId}\u0000${conversationId}`, converter);
    stream.start(async (batch) => {
      if (this.onAcp.has(`${agentId}\u0000${conversationId}`)) return;
      const events = batch.flatMap((ev) => converter.convert(ev));
      if (events.length) this.push(agentId, conversationId, events);
      // A compaction drops what the chat had loaded from MCP with the rest of its context.
      if (batch.some((ev) => ev.type === "compaction_end")) await this.deps.mcp?.forget(chat, this.deps.context).catch(() => {});
    });
  }

  /** Whether a turn is running in a chat, or waits on the person (the background passes leave such a chat alone). */
  async busy(agentId: string, conversationId: string): Promise<boolean> {
    const store = await this.deps.stores.get(agentId);
    const chat = await store.chat(conversationId, this.deps.context);
    if (!chat) return false;
    if (await this.engine(agentId, conversationId, store, chat)) return this.acp.busy(agentId, conversationId);
    if (this.deps.approvals.waitingIn(agentId, conversationId).length > 0) return true;
    return Boolean((await store.harness.snapshot(LiveDoc, chat.id, this.deps.context))?.run);
  }

  private async state(store: AgentStore, chat: Conversation, agentId: string, conversationId: string): Promise<ChatState> {
    const [view, settings] = await Promise.all([store.harness.snapshot(LiveDoc, chat.id, this.deps.context), store.agentSettings(chat.id, this.deps.context)]);
    const info = await store.chatInfo(chat.id, this.deps.context);
    const waiting = this.deps.approvals.waitingIn(agentId, conversationId).length > 0;
    // The answer in flight so far: the client that opens now missed its first pieces (they went out before it listened).
    const streaming = view?.run ? (this.converters.get(`${agentId}\u0000${conversationId}`)?.inFlight() ?? null) : null;
    return {
      agent_id: agentId,
      conversation_id: conversationId,
      loop: waiting ? "approval" : view?.run ? "running" : "idle",
      turn_id: view?.run ? turnIdOf(agentId, view.run.inputs) : null,
      mode: isPermissionMode(info?.mode) ? info.mode : "unrestricted",
      cwd: (settings as { cwd?: string } | undefined)?.cwd ?? null,
      ...(streaming ? { streaming } : {}),
    };
  }

  async create(agentId: string, cwd: string | null, title: string | null): Promise<{ agentId: string; conversationId: string }> {
    const store = await this.deps.stores.get(agentId);
    const conversationId = `local-conv-${randomUUID()}`;
    const model = modelRef(readLocalAgent(agentId, this.deps.backendDir)?.model ?? "");
    await store.createChat(conversationId, { title, agent: { ...(model ? { model } : {}), ...(cwd ? { cwd } : {}) } }, this.deps.context);
    return { agentId, conversationId };
  }

  /** A chat whose model pi-ai cannot name (one imported from Letta under Letta's name) is moved to the name it can. */
  private async healModel(store: AgentStore, chat: Conversation): Promise<void> {
    const model = ((await store.agentSettings(chat.id, this.deps.context)) as { model?: { provider?: string; modelId?: string } } | undefined)?.model;
    if (!model?.provider || !model.modelId || this.deps.models.getProvider(model.provider)) return;
    const healed = modelRef(piHandle(`${model.provider}/${model.modelId}`, (id) => Boolean(this.deps.models.getProvider(id))));
    if (healed && healed.provider !== model.provider) await chat.configure({ model: healed }, this.deps.context);
  }

  async send(p: PayloadOf<"chat_send">): Promise<boolean> {
    const { store, chat } = await this.chat(p.agent_id, p.conversation_id);
    const engine = await this.engine(p.agent_id, p.conversation_id, store, chat);
    if (engine) {
      this.acp.send(p, engine);
      return true;
    }
    await this.healModel(store, chat);
    await this.deps.mcp?.prepare(store, chat, this.deps.context);
    await this.watch(store, chat, p.agent_id, p.conversation_id);
    const images = p.images.map((i) => ({ type: "image" as const, data: i.data, mimeType: i.media_type }));
    const parts = [
      ...(p.context ? [{ type: "text" as const, text: p.context }] : []),
      ...(p.text.trim() ? [{ type: "text" as const, text: p.text }] : []),
      ...images,
    ];
    const agentName = readLocalAgent(p.agent_id, this.deps.backendDir)?.name ?? "";
    const content = this.deps.mods.transformMessage({
      chatId: p.conversation_id,
      agentId: p.agent_id,
      agentName,
      content: parts.length === 1 && parts[0].type === "text" ? parts[0].text : parts,
      typed: p.text.trim() !== "",
    });
    await chat.submit({ type: "input", content: content as never, ...(p.send_id ? { requestId: p.send_id } : {}) }, this.deps.context);
    return true;
  }

  /**
   * A message from loki itself (a background task's notice, a schedule's prompt). `steer` puts it into a running turn
   * at its next step, where the work it reports on is; otherwise it waits for the turn to end and starts its own.
   */
  async deliver(agentId: string, conversationId: string, text: string, whenBusy: "steer" | "followUp" = "followUp"): Promise<void> {
    const { store, chat } = await this.chat(agentId, conversationId);
    const engine = await this.engine(agentId, conversationId, store, chat);
    if (engine) return this.acp.deliver(agentId, conversationId, text, engine);
    await this.healModel(store, chat);
    await this.deps.mcp?.prepare(store, chat, this.deps.context);
    await this.watch(store, chat, agentId, conversationId);
    await chat.submit({ type: "input", content: text, whenBusy }, this.deps.context);
  }

  importLetta(): Promise<ImportReport> {
    if (!this.deps.importLetta) throw new Error("this daemon does not import from Letta");
    return this.deps.importLetta();
  }

  importStatus(): Promise<ImportStatus> {
    return settled(() => this.deps.importStatus?.() ?? { letta: false, complete: false, last: null });
  }

  async abort(agentId: string, conversationId: string): Promise<void> {
    const { store, chat } = await this.chat(agentId, conversationId);
    if (await this.engine(agentId, conversationId, store, chat)) return this.acp.abort(agentId, conversationId);
    await chat.abort(this.deps.context);
  }

  async update(p: PayloadOf<"chat_update">): Promise<void> {
    const store = await this.deps.stores.get(p.agent_id);
    const change = {
      ...(p.title !== undefined ? { title: p.title } : {}),
      ...(p.archived !== undefined ? { archived: p.archived } : {}),
      ...(p.hidden !== undefined ? { hidden: p.hidden } : {}),
    };
    if (!(await store.updateChat(p.conversation_id, change, this.deps.context))) throw new Error(`no chat ${p.conversation_id}`);
  }

  async folder(agentId: string, conversationId: string, cwd: string): Promise<ChatState> {
    const { store, chat } = await this.chat(agentId, conversationId);
    // An agent's session runs in the folder it was opened in.
    if ((await this.engine(agentId, conversationId, store, chat))?.session_id)
      throw new Error("this chat runs on an ACP agent in the folder it started in; start a new chat for another folder");
    await chat.configure({ cwd }, this.deps.context);
    this.push(agentId, conversationId, [{ kind: "device", cwd }]);
    return this.state(store, chat, agentId, conversationId);
  }

  /**
   * The chat's model. An ACP model (`acp:<agent>/<model>`) makes it an ACP chat; before its first message a chat can
   * move between engines, and after it only between one engine's models (plan 020, KD4).
   */
  async model(p: PayloadOf<"chat_model">): Promise<void> {
    const { store, chat } = await this.chat(p.agent_id, p.conversation_id);
    const engine = await this.engine(p.agent_id, p.conversation_id, store, chat);
    const wanted = acpHandle(p.handle);
    if (wanted) {
      if (!this.acp.agent(wanted.agent)) throw new Error(`no ACP agent named ${wanted.agent}`);
      if (engine?.agent !== wanted.agent && (await this.started(chat)))
        throw new Error("this chat has started on another engine; start a new chat to use this one");
      const next: ChatEngine = { kind: "acp", agent: wanted.agent, model: wanted.model, session_id: engine?.agent === wanted.agent ? engine.session_id : null };
      await store.updateChat(p.conversation_id, { engine: next }, this.deps.context);
      this.onAcp.add(`${p.agent_id}\u0000${p.conversation_id}`);
      if (engine?.agent === wanted.agent) await this.acp.setModel(p.agent_id, p.conversation_id, wanted.model);
      else {
        // The agent's own modes replace loki's: its first until its session says which one it is in.
        const view = this.acp.view(p.agent_id, p.conversation_id, next);
        this.push(p.agent_id, p.conversation_id, [{ kind: "device", engine: view, ...(view.modes.length ? { mode: view.modes[0].id } : {}) }]);
      }
      return;
    }
    if (engine) {
      if (await this.started(chat)) throw new Error("this chat has started on an ACP agent; start a new chat to use loki's models");
      await store.updateChat(p.conversation_id, { engine: null }, this.deps.context);
      this.onAcp.delete(`${p.agent_id}\u0000${p.conversation_id}`);
      const mode = (await store.chatInfo(chat.id, this.deps.context))?.mode;
      this.push(p.agent_id, p.conversation_id, [{ kind: "device", engine: null, mode: isPermissionMode(mode) ? mode : "unrestricted" }]);
    }
    const model = modelRef(p.handle);
    if (!model) throw new Error(`not a model handle: ${p.handle}`);
    const level = thinkingLevel(p.reasoning_effort);
    await chat.configure({ model, ...(level ? { thinkingLevel: level as never } : {}) }, this.deps.context);
  }

  async models(): Promise<ModelEntry[]> {
    const available = await this.deps.models.getAvailable();
    const own = available.map((m) => ({ id: `${m.provider}/${m.id}`, handle: `${m.provider}/${m.id}`, label: m.name || m.id }));
    // Each ACP agent's models after loki's own (plan 020, KD3): picking one before the first message moves the chat there.
    return [...own, ...(this.deps.acp?.models() ?? [])];
  }

  agents(): Promise<Array<{ id: string; name: string }>> {
    return settled(() => listAgents(this.deps.backendDir).map((id) => ({ id, name: readLocalAgent(id, this.deps.backendDir)?.name ?? id })));
  }

  async createAgent(p: PayloadOf<"chat_agent_create">): Promise<{ id: string; name: string }> {
    const id = await createAgent(this.deps.backendDir, {
      name: p.name,
      ...(p.description ? { description: p.description } : {}),
      ...(p.persona ? { persona: p.persona } : {}),
      ...(p.model ? { model: p.model } : {}),
    });
    const store = await this.deps.stores.get(id);
    await store.setAgent({ id, name: p.name }, this.deps.context);
    const model = p.model ? modelRef(p.model) : undefined;
    await store.createChat("default", { agent: model ? { model } : {} }, this.deps.context);
    return { id, name: p.name };
  }

  async updateAgent(p: PayloadOf<"chat_agent_update">): Promise<void> {
    const file = join(this.deps.backendDir, "agents", `${backendName(p.agent_id)}.json`);
    const record = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    if (p.name !== undefined) record.name = p.name;
    if (p.description !== undefined) record.description = p.description;
    if (p.model !== undefined) record.model = p.model;
    writeRecord(this.deps.backendDir, p.agent_id, record);
    if (p.name !== undefined) await (await this.deps.stores.get(p.agent_id)).setAgent({ id: p.agent_id, name: p.name }, this.deps.context);
  }

  providers() {
    return this.deps.providers.list();
  }

  connectProvider(providerId: string, apiKey: string): Promise<void> {
    return this.deps.providers.connectKey(providerId, apiKey);
  }

  disconnectProvider(providerId: string): Promise<void> {
    return this.deps.providers.disconnect(providerId);
  }

  async signIn(providerId: string, code: string | null = null) {
    if (code === null) return this.deps.providers.signIn(providerId);
    this.deps.providers.finishSignIn(providerId, code);
    return { url: "", instructions: null };
  }

  passes() {
    return settled(() => {
      if (!this.deps.passes) throw new Error("the background passes are not running");
      return this.deps.passes.state.settings();
    });
  }

  setPasses(s: PayloadOf<"chat_passes_set">) {
    return settled(() => {
      if (!this.deps.passes) throw new Error("the background passes are not running");
      return this.deps.passes.state.setSettings(s);
    });
  }

  /** Learn's "Run now": every settled chat it has new material in, whether Learn is on or not. */
  async runLearn(): Promise<void> {
    if (!this.deps.passes) throw new Error("the background passes are not running");
    await this.deps.passes.runner.runAllNow("learn");
  }

  /** The slash commands the daemon runs: /compact [instructions], /clear, /remember [what], /reflect, /doctor. */
  async command(p: PayloadOf<"chat_command">): Promise<{ success: boolean; output: string }> {
    const { store, chat } = await this.chat(p.agent_id, p.conversation_id);
    const engine = await this.engine(p.agent_id, p.conversation_id, store, chat);
    // On an ACP agent, every command but loki's passes is the agent's: it goes to the agent as it was typed.
    if (engine && p.command !== "reflect" && p.command !== "doctor") {
      const typed = `/${p.command}${p.args?.trim() ? ` ${p.args.trim()}` : ""}`;
      this.acp.deliver(p.agent_id, p.conversation_id, typed, engine);
      return { success: true, output: `sent ${typed} to the agent` };
    }
    switch (p.command) {
      case "compact":
        await chat.compact(p.args?.trim() || undefined, this.deps.context);
        return { success: true, output: "summarising the conversation so far" };
      case "clear":
        await chat.reset(undefined, this.deps.context);
        await this.deps.mcp?.forget(chat, this.deps.context);
        return { success: true, output: "the agent starts this chat afresh; what was said stays in the thread" };
      case "remember": {
        const what = p.args?.trim();
        const text = what
          ? `Please remember this in your memory: ${what}`
          : "Look back over this conversation and save to your memory whatever is worth keeping.";
        await this.deps.mcp?.prepare(await this.deps.stores.get(p.agent_id), chat, this.deps.context);
        await chat.submit({ type: "input", content: text }, this.deps.context);
        return { success: true, output: "asked the agent to remember" };
      }
      case "reflect":
        if (!this.deps.passes) return { success: false, output: "reflection is not running" };
        // The pass runs on its own, even with reflection off; its memory changes show on the agent's page when it is done.
        void this.deps.passes.runner.runNow("reflection", p.agent_id, p.conversation_id).catch(() => {});
        return { success: true, output: "reflecting on this chat; its memory changes show on the agent's page" };
      case "doctor": {
        if (!this.deps.passes) return { success: false, output: "the background passes are not running" };
        // Waits for the review: its report is the command's answer, and each change is a commit on the agent's Changes page.
        const r = await this.deps.passes.runner.runDoctor(p.agent_id);
        const tail = r.changes
          ? `\n\n${r.changes} change${r.changes === 1 ? "" : "s"} committed by Doctor; Agents › Changes shows each, and Revert undoes one.`
          : "";
        return { success: r.outcome !== "failed" && r.outcome !== "skipped", output: `${r.report}${tail}` };
      }
      default:
        return { success: false, output: `/${p.command} is not a command loki's daemon runs` };
    }
  }

  /** A skill made global: a link to its folder in the global skills folder, ~/.agents/skills (mod/skills.ts). */
  enableSkill(path: string): Promise<{ name: string; linkPath: string }> {
    return settled(() => {
      if (!existsSync(join(path, "SKILL.md"))) throw new Error(`${path} has no SKILL.md`);
      const dir = globalSkillsDir();
      mkdirSync(dir, { recursive: true });
      const name = basename(path);
      const linkPath = join(dir, name);
      if (existsSync(linkPath)) throw new Error(`a global skill named ${name} is already there`);
      symlinkSync(path, linkPath, "dir");
      return { name, linkPath };
    });
  }

  disableSkill(name: string): Promise<void> {
    return settled(() => {
      const linkPath = join(globalSkillsDir(), name);
      if (!lstatSync(linkPath, { throwIfNoEntry: false })?.isSymbolicLink()) throw new Error(`${name} is not a linked global skill`);
      unlinkSync(linkPath);
    });
  }

  async writeMemory(p: PayloadOf<"chat_memory_write">): Promise<void> {
    await editMemoryFile(this.deps.backendDir, p.agent_id, p.path, p.content, p.message);
  }

  /** One memory commit undone, by a new commit as yours (the Agents page's Revert). */
  async revertMemory(p: PayloadOf<"chat_memory_revert">): Promise<void> {
    await revertMemoryCommit(this.deps.backendDir, p.agent_id, p.sha);
  }

  async deleteAgent(agentId: string): Promise<void> {
    await this.deps.stores.close(agentId);
    for (const path of [
      this.deps.stores.file(agentId),
      `${this.deps.stores.file(agentId)}-wal`,
      `${this.deps.stores.file(agentId)}-shm`,
      join(this.deps.backendDir, "memfs", agentId),
      join(this.deps.backendDir, "agents", `${backendName(agentId)}.json`),
    ]) {
      rmSync(path, { recursive: true, force: true });
    }
  }
}
