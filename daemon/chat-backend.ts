import type { Context } from "@earendil-works/chord";
import { getSupportedThinkingLevels, type Models } from "@earendil-works/pi-ai/models";
import type { Conversation } from "@earendil-works/pi-durable";
import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync, symlinkSync, unlinkSync } from "node:fs";
import { basename, join } from "node:path";
import { globalSkillsDir } from "../mod/skills.ts";
import type { ChatEvent } from "../core/attention/model.ts";
import { shownStep, type ImageNamer } from "../core/attention/pi-steps.ts";
import { backendName } from "../core/desk-core.ts";
import type { ChatState, PayloadOf } from "../core/frames.ts";
import type { EnginesView, McpView } from "../core/frame-types.ts";
import { isReasoningEffort, type ModelEntry } from "../core/models.ts";
import { readLocalAgent } from "../mod/agents.ts";
import type { ChatBackend } from "../mod/frames/chat.ts";
import type { Approvals } from "./approvals.ts";
import { engineMoveRefused, type Delivery, type Engine, type EngineChat } from "./engine.ts";
import { LokiEngine, modelRef } from "./loki-engine.ts";
import { AcpEngine } from "./acp/engine.ts";
import type { Providers } from "./providers.ts";
import type { PassRunner } from "./passes.ts";
import type { McpTools } from "./mcp/index.ts";
import type { PassState } from "./passes-state.ts";
import { editMemoryFile, isDoctorChat, isReflectionChat, revertMemoryCommit } from "./memory.ts";
import type { AgentStore, ChatInfo } from "./kernel/index.ts";
import { LabelColors, type LabelColorsSnapshot } from "./labels.ts";
import { exportChat, importChat, type MoveNames, type MovedChat } from "./chat-move.ts";
import type { Schedules } from "./schedule.ts";
import { homeOf, readRecord } from "./store/agent-sync.ts";
import { chatLabels, type LabelView } from "../core/labels.ts";
import { acpHandle } from "./acp/agents.ts";
import type { AcpChats } from "./acp/chats.ts";
import type { StoreManager } from "./kernel/stores.ts";
import type { ModRegistry } from "./mods/registry.ts";
import { createAgent, listAgents, writeRecord } from "./store/agents.ts";
import { SYNCED_FIELDS, addTombstone, stamp, type Stamp } from "./store/agent-sync.ts";

/**
 * Chats on loki's daemon, as the mod's chat frames ask for them (plan 017, U5; mod/frames/chat.ts). Each chat runs on
 * an engine (daemon/engine.ts): loki's own on pi-durable (daemon/loki-engine.ts), or an ACP agent
 * (daemon/acp/engine.ts). This module finds a chat's engine and hands it every call about that chat; what it keeps is
 * what spans engines or chats: when a chat may move to another engine, labels, agents, the passes and moves.
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
  /** Where each label's colour is kept (`state/labels.json`, plan 022); absent, only while the daemon runs. */
  labelsFile?: string;
  /** Keeps the person's pictures as files a window loads (daemon/chat-images.ts, plan 029); absent in tests that need none. */
  nameImage?: ImageNamer;
  /** The daemon's agents' folder (daemon/store/agents.ts). */
  backendDir: string;
  context: Context;
  report?: (message: string) => void;
  /** This Mac's install id (plan 023): stamped on agent record changes so paired Macs keep the later one. */
  macId?: string;
  /** The scheduled tasks (daemon/schedule.ts), which move with their chat to another Mac (plan 023, U9). */
  schedules?: Schedules;
  /** The clock for those stamps; Date.now unless a test sets it. */
  now?: () => number;
}

/**
 * A synchronous answer as the promise ChatBackend asks for: a throw becomes its rejection, as in an async method,
 * so a caller's catch still sees it.
 */
const settled = <T>(work: () => T): Promise<T> => new Promise((resolve) => resolve(work()));

/**
 * loki's own models as the picker lists them: one entry per model, or one per reasoning effort pi-ai says it takes
 * (its thinking levels, "off" as no reasoning), so Select model offers the levels under the list (plan 021).
 */
export function lokiModelEntries(available: ReadonlyArray<Parameters<typeof getSupportedThinkingLevels>[0]>): ModelEntry[] {
  return available.flatMap((m) => {
    const handle = `${m.provider}/${m.id}`;
    const entry: ModelEntry = { id: handle, handle, label: m.name || m.id };
    const efforts = getSupportedThinkingLevels(m)
      .map((level) => (level === "off" ? "none" : level))
      .filter(isReasoningEffort);
    return efforts.length > 1 ? efforts.map((e): ModelEntry => ({ ...entry, id: `${handle}@${e}`, reasoning_effort: e })) : [entry];
  });
}

/**
 * The daemon's ChatBackend: opens, sends to and changes chats through their engines, and pushes their events, the
 * approvals and questions included, to the clients through `attach`'s callback.
 */
export class DaemonChats implements ChatBackend {
  private push: (agentId: string, conversationId: string, events: ChatEvent[]) => void = () => {};
  private readonly deps: Deps;
  /** The two engines a chat can run on (daemon/engine.ts): loki's own, and an ACP agent when the daemon runs them. */
  private readonly loki: LokiEngine;
  private readonly acpEngine: AcpEngine | null;

  /** Each label's colour (plan 022). */
  private readonly colors: LabelColors;

  constructor(deps: Deps) {
    this.deps = deps;
    this.colors = new LabelColors(deps.labelsFile);
    const push = (agentId: string, conversationId: string, events: ChatEvent[]) => this.push(agentId, conversationId, events);
    this.loki = new LokiEngine({ ...deps, push });
    this.acpEngine = deps.acp ? new AcpEngine({ acp: deps.acp, context: deps.context, push }) : null;
    // A store that reopens after a failure has new conversations: what followed the old ones follows again on open.
    deps.stores.onOpen((agentId) => this.loki.forgetAgent(agentId));
  }

  /**
   * Where chat events go: to every window following the chat (the mod's sockets). Every engine's events pass here,
   * so this is where a step is cut to what a window shows (plan 035): a tool's whole output never leaves the daemon.
   */
  attach(push: (agentId: string, conversationId: string, events: ChatEvent[]) => void): void {
    const shown = (agentId: string, conversationId: string, events: ChatEvent[]) =>
      push(
        agentId,
        conversationId,
        events.map((e) => (e.kind === "step" ? { kind: "step", step: shownStep(e.step) } : e)),
      );
    this.push = shown;
    this.deps.approvals.attach(shown);
    this.deps.acp?.attach(shown);
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

  /** A chat with the engine it runs on: an ACP agent when it names one and the daemon runs them, else loki's own. */
  private async resolve(agentId: string, conversationId: string): Promise<{ c: EngineChat; engine: Engine }> {
    const store = await this.deps.stores.get(agentId);
    const chat = await store.chat(conversationId, this.deps.context);
    if (!chat) throw new Error(`no chat ${conversationId} for ${agentId}`);
    const saved = (await store.chatInfo(chat.id, this.deps.context))?.engine;
    const onAcp = saved?.kind === "acp" && this.acpEngine ? { saved, engine: this.acpEngine } : null;
    return { c: { agentId, conversationId, store, chat, engine: onAcp?.saved ?? null }, engine: onAcp?.engine ?? this.loki };
  }

  async open(agentId: string, conversationId: string, mode: string | null = null): Promise<ChatState> {
    const { c, engine } = await this.resolve(agentId, conversationId);
    const state = await engine.open(c, mode);
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

  /** Whether a turn is running in a chat, or waits on the person (the background passes leave such a chat alone). */
  async busy(agentId: string, conversationId: string): Promise<boolean> {
    const store = await this.deps.stores.get(agentId);
    if (!(await store.chat(conversationId, this.deps.context))) return false;
    const { c, engine } = await this.resolve(agentId, conversationId);
    return engine.busy(c);
  }

  /**
   * A new chat here. `home` is the Mac the person picked for it; picked here while its agent lives on another Mac, the
   * chat is placed (addendum A2), so the hand-over of that agent's chats leaves it here.
   */
  async create(agentId: string, cwd: string | null, title: string | null, home: string | null = null): Promise<{ agentId: string; conversationId: string }> {
    const store = await this.deps.stores.get(agentId);
    const conversationId = `local-conv-${randomUUID()}`;
    const model = modelRef(readLocalAgent(agentId, this.deps.backendDir)?.model ?? "");
    await store.createChat(conversationId, { title, agent: { ...(model ? { model } : {}), ...(cwd ? { cwd } : {}) } }, this.deps.context);
    const here = this.deps.macId ?? "";
    if (home && here && homeOf(readRecord(this.deps.backendDir, agentId), here) !== here)
      await store.updateChat(conversationId, { placed: true }, this.deps.context);
    return { agentId, conversationId };
  }

  async send(p: PayloadOf<"chat_send">): Promise<boolean> {
    const { c, engine } = await this.resolve(p.agent_id, p.conversation_id);
    await engine.send(c, p);
    return true;
  }

  /**
   * A message from loki itself (a background task's notice, a schedule's prompt). `steer` puts it into a running turn
   * at its next step, where the work it reports on is; otherwise it waits for the turn to end and starts its own.
   */
  async deliver(agentId: string, conversationId: string, text: string, whenBusy: "steer" | "followUp" = "followUp"): Promise<Delivery | null> {
    const { c, engine } = await this.resolve(agentId, conversationId);
    return engine.deliver(c, text, whenBusy);
  }

  async abort(agentId: string, conversationId: string): Promise<void> {
    const { c, engine } = await this.resolve(agentId, conversationId);
    await engine.abort(c);
  }

  async update(p: PayloadOf<"chat_update">): Promise<void> {
    const store = await this.deps.stores.get(p.agent_id);
    const change = {
      ...(p.title !== undefined ? { title: p.title } : {}),
      ...(p.archived !== undefined ? { archived: p.archived } : {}),
      ...(p.hidden !== undefined ? { hidden: p.hidden } : {}),
      ...(p.labels !== undefined ? { labels: p.labels } : {}),
    };
    if (!(await store.updateChat(p.conversation_id, change, this.deps.context))) throw new Error(`no chat ${p.conversation_id}`);
    // A new label takes its colour now, so every client shows it the same from the start.
    for (const label of p.labels ?? []) this.colors.colorOf(label);
  }

  /** Every agent's chats with their saved details, for what spans them all (labels). */
  private async everyChat(): Promise<Array<{ store: AgentStore; info: ChatInfo }>> {
    const all = await Promise.all(
      listAgents(this.deps.backendDir).map(async (id) => {
        const store = await this.deps.stores.get(id);
        return (await store.chats(this.deps.context)).map((info) => ({ store, info }));
      }),
    );
    return all.flat();
  }

  async labels(): Promise<{ labels: LabelView[] }> {
    const counts = new Map<string, number>();
    for (const { info } of await this.everyChat()) if (!info.hidden) for (const l of info.labels ?? []) counts.set(l, (counts.get(l) ?? 0) + 1);
    const labels = [...counts].map(([name, chats]) => ({ name, color: this.colors.colorOf(name), chats }));
    return { labels: labels.sort((a, b) => a.name.localeCompare(b.name)) };
  }

  /**
   * Rename, recolour or delete a label (plan 022, R6). A rename or a delete changes every chat that carries it; a
   * rename onto a label a chat already has leaves it there once.
   */
  async setLabel(p: PayloadOf<"chat_label_set">): Promise<{ labels: LabelView[] }> {
    if ("remove" in p || p.rename) {
      const to = "remove" in p ? null : (p.rename ?? null);
      for (const { store, info } of await this.everyChat()) {
        if (!info.labels?.includes(p.name)) continue;
        const labels = chatLabels(info.labels.flatMap((l) => (l !== p.name ? [l] : to ? [to] : [])));
        await store.updateChat(info.id, { labels }, this.deps.context);
      }
      if (to) this.colors.rename(p.name, to);
      else this.colors.remove(p.name);
    }
    if (!("remove" in p) && p.color !== undefined) this.colors.set(p.rename ?? p.name, p.color);
    return this.labels();
  }

  async folder(agentId: string, conversationId: string, cwd: string): Promise<ChatState> {
    const { c, engine } = await this.resolve(agentId, conversationId);
    return engine.folder(c, cwd);
  }

  /**
   * The chat's model. An ACP model (`acp:<agent>/<model>`) makes it an ACP chat; before its first message a chat can
   * move between engines, and after it only between one engine's models (plan 020, KD4).
   */
  async model(p: PayloadOf<"chat_model">): Promise<void> {
    const { c, engine: from } = await this.resolve(p.agent_id, p.conversation_id);
    const wanted = acpHandle(p.handle);
    if (wanted && !this.acp.agent(wanted.agent)) throw new Error(`no ACP agent named ${wanted.agent}`);
    const to = wanted ? this.acpEngine : this.loki;
    if (!to) throw new Error("ACP agents are not running in this daemon");
    const started = await this.started(c.chat);
    const refused = engineMoveRefused(c.engine, wanted?.agent ?? null, started);
    if (refused) throw new Error(refused);
    if (from !== to) await from.leave(c);
    await to.setModel(c, p, started);
  }

  async models(): Promise<ModelEntry[]> {
    const own = lokiModelEntries(await this.deps.models.getAvailable());
    // Each ACP agent's models after loki's own (plan 020, KD3): picking one before the first message moves the chat there.
    return [...own, ...(this.deps.acp?.models() ?? [])];
  }

  agents(): Promise<Array<{ id: string; name: string }>> {
    return settled(() =>
      listAgents(this.deps.backendDir).map((id) => {
        const agent = readLocalAgent(id, this.deps.backendDir);
        return { id, name: agent?.name ?? id, home_mac: agent?.home_mac ?? null };
      }),
    );
  }

  /** Now, on this Mac: the stamp a record change carries to paired Macs (plan 023, U3). */
  private stampNow(): Stamp {
    return { at: new Date((this.deps.now ?? Date.now)()).toISOString(), mac: this.deps.macId ?? "" };
  }

  async createAgent(p: PayloadOf<"chat_agent_create">): Promise<{ id: string; name: string }> {
    const id = await createAgent(this.deps.backendDir, {
      name: p.name,
      ...(p.description ? { description: p.description } : {}),
      ...(p.persona ? { persona: p.persona } : {}),
      ...(p.model ? { model: p.model } : {}),
      ...(this.deps.macId ? { home_mac: this.deps.macId } : {}),
    });
    // Every field is new here: a paired Mac takes them all, and the agent lives on the Mac that made it.
    const file = join(this.deps.backendDir, "agents", `${backendName(id)}.json`);
    writeRecord(this.deps.backendDir, id, stamp(JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>, SYNCED_FIELDS, this.stampNow()));
    const store = await this.deps.stores.get(id);
    await store.setAgent({ id, name: p.name }, this.deps.context);
    const model = p.model ? modelRef(p.model) : undefined;
    await store.createChat("default", { agent: model ? { model } : {} }, this.deps.context);
    return { id, name: p.name };
  }

  async updateAgent(p: PayloadOf<"chat_agent_update">): Promise<void> {
    const file = join(this.deps.backendDir, "agents", `${backendName(p.agent_id)}.json`);
    const record = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    const changed = (["name", "description", "model", "home_mac"] as const).filter((f) => p[f] !== undefined);
    for (const f of changed) record[f] = p[f];
    writeRecord(this.deps.backendDir, p.agent_id, stamp(record, changed, this.stampNow()));
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

  /** A slash command: loki's passes (/reflect, /doctor) run here; every other is the chat's engine's (Engine.command). */
  async command(p: PayloadOf<"chat_command">): Promise<{ success: boolean; output: string }> {
    const { c, engine } = await this.resolve(p.agent_id, p.conversation_id);
    switch (p.command) {
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
        // Every other command is the engine's: pi-durable's /compact, /clear and /remember, or the agent's own.
        return engine.command(c, p);
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

  /** Delete an agent here and leave a tombstone, so paired Macs delete it too rather than send it back. */
  /**
   * The chats here of agents that live on `mac`, for that Mac to take over when it first pairs (plan 023, U9): the
   * person's own, not hidden, and not on an ACP agent, whose session belongs to this Mac. A chat put here on purpose
   * stays (addendum A2).
   */
  async moveCandidates(mac: string): Promise<Array<{ agent_id: string; conversation_id: string }>> {
    const out: Array<{ agent_id: string; conversation_id: string }> = [];
    for (const agentId of listAgents(this.deps.backendDir)) {
      if (homeOf(readRecord(this.deps.backendDir, agentId), this.deps.macId ?? "") !== mac) continue;
      const store = await this.deps.stores.get(agentId);
      for (const info of await store.chats(this.deps.context)) {
        if (info.hidden || info.placed || info.engine?.kind === "acp" || isReflectionChat(info.id) || isDoctorChat(info.id)) continue;
        out.push({ agent_id: agentId, conversation_id: info.id });
      }
    }
    return out;
  }

  /** A chat copied out for another Mac, or `busy` while a turn runs or an approval waits, when it must wait to move. */
  async exportChat(agentId: string, chatId: string): Promise<{ chat: MovedChat | null; busy: boolean }> {
    if ((await this.busy(agentId, chatId)) || this.deps.approvals.waitingIn(agentId, chatId).length > 0) return { chat: null, busy: true };
    const store = await this.deps.stores.get(agentId);
    const schedules = (this.deps.schedules?.list() ?? []).filter((t) => t.status === "active" && t.agent_id === agentId && t.conversation_id === chatId);
    const cursors: Record<string, number> = {};
    for (const job of ["reflection", "learn"] as const) {
      const at = this.deps.passes?.state.cursor(job, agentId, chatId);
      if (at !== undefined) cursors[job] = at;
    }
    return { chat: await exportChat(store, agentId, chatId, { schedules, cursors }, this.deps.context), busy: false };
  }

  /**
   * A chat moved here from another Mac: its log, its schedules and its passes' cursors. False when it was already here.
   * `names` marks the thread where it moved and tells the agent with the next message (addendum A5).
   */
  async importChat(moved: MovedChat, names?: MoveNames): Promise<boolean> {
    const store = await this.deps.stores.get(moved.agent_id);
    const made = await importChat(store, moved, this.deps.context, names);
    for (const task of moved.schedules) this.deps.schedules?.adopt(task);
    for (const [job, at] of Object.entries(moved.cursors))
      if (job === "reflection" || job === "learn") this.deps.passes?.state.setCursor(job, moved.agent_id, moved.conversation_id, at);
    return made;
  }

  /** The other Mac has the chat now: hide it here and stop its schedules, so it lives and fires on one Mac only. */
  async finishMove(agentId: string, chatId: string): Promise<void> {
    const store = await this.deps.stores.get(agentId);
    await store.updateChat(chatId, { hidden: true }, this.deps.context);
    for (const t of this.deps.schedules?.list() ?? [])
      if (t.status === "active" && t.agent_id === agentId && t.conversation_id === chatId) this.deps.schedules?.cancel(agentId, t.id);
  }

  /** The person's label colours, for a paired Mac (plan 023, U8). */
  labelColors(): LabelColorsSnapshot {
    return this.colors.snapshot();
  }

  /** A paired Mac's label colours: true when one here changed. */
  applyLabelColors(theirs: LabelColorsSnapshot): boolean {
    return this.colors.apply(theirs);
  }

  async deleteAgent(agentId: string): Promise<void> {
    addTombstone(this.deps.backendDir, { id: agentId, ...this.stampNow() });
    await this.removeAgent(agentId);
  }

  /** Remove an agent's store, memory and record here, as a delete on another Mac asks; no tombstone of this Mac's. */
  async removeAgent(agentId: string): Promise<void> {
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
