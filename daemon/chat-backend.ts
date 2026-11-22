import type { Context } from "@earendil-works/chord";
import { getSupportedThinkingLevels, type Models } from "@earendil-works/pi-ai/models";
import type { Conversation } from "@earendil-works/pi-durable";
import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync, symlinkSync, unlinkSync } from "node:fs";
import { basename, join } from "node:path";
import { globalSkillsDir } from "../mod/skills.ts";
import type { ChatEvent } from "../core/attention/model.ts";
import { daemonTimeReminder } from "../core/attention/content.ts";
import { shownStep, type ImageNamer } from "../core/attention/pi-steps.ts";
import { backendName, MAIN_CHAT_ID } from "../core/desk-core.ts";
import { DRAFT_HELD, type ChatState, type PayloadOf, type Replies } from "../core/frames.ts";
import type { EnginesView, McpView } from "../core/frame-types.ts";
import { isReasoningEffort, type ModelEntry, type ReasoningEffort } from "../core/models.ts";
import { readLocalAgent } from "../mod/agents.ts";
import type { ChatBackend } from "../mod/frames/chat.ts";
import type { Approvals } from "./approvals.ts";
import { engineMoveRefused, type Delivery, type Engine, type EngineChat } from "./engine.ts";
import { LokiEngine, modelRef } from "./loki-engine.ts";
import { keyedQueue } from "../core/serial.ts";
import { messageOf } from "../core/errors.ts";
import { looserThan, lokiModeOf, modeOf, stricterMode, UNKNOWN_CAP, type PermissionMode } from "../core/chat-links.ts";
import { AcpEngine } from "./acp/engine.ts";
import type { Providers } from "./providers.ts";
import type { PassRunner } from "./passes.ts";
import type { McpTools } from "./mcp/index.ts";
import type { PassState } from "./passes-state.ts";
import { editMemoryFile, isDoctorChat, isReflectionChat, revertMemoryCommit } from "./memory.ts";
import type { AgentStore, ChatInfo } from "./kernel/index.ts";
import { LabelColors, type LabelColorsSnapshot } from "./labels.ts";
import { exportChat, importChat, type MoveNames, type MovedChat } from "./chat-move.ts";
import type { BackgroundTasks } from "./background.ts";
import type { Schedules } from "./schedule.ts";
import { homeOf, readRecord } from "./store/agent-sync.ts";
import { chatLabels, type LabelView } from "../core/labels.ts";
import { acpHandle } from "./acp/agents.ts";
import type { AcpChats } from "./acp/chats.ts";
import type { StoreManager } from "./kernel/stores.ts";
import type { ModRegistry } from "./mods/registry.ts";
import { createAgent, listAgents, writeRecord } from "./store/agents.ts";
import { SYNCED_FIELDS, addTombstone, stamp, type Stamp } from "./store/agent-sync.ts";

interface Deps {
  stores: StoreManager;
  approvals: Approvals;
  providers: Providers;
  passes?: { runner: PassRunner; state: PassState };
  mcp?: McpTools;
  mods: ModRegistry;
  models: Models;
  acp?: AcpChats;
  labelsFile?: string;
  nameImage?: ImageNamer;
  backendDir: string;
  context: Context;
  report?: (message: string) => void;
  macId?: string;
  schedules?: Schedules;
  background?: Pick<BackgroundTasks, "stopAgent">;
  now?: () => number;
  usualModel?: (agentId: string) => { handle: string; reasoning_effort: ReasoningEffort | null } | null;
}

/**
 * A synchronous answer as the promise ChatBackend asks for: a throw becomes its rejection, as in an async method,
 * so a caller's catch still sees it.
 */
const settled = <T>(work: () => T): Promise<T> => new Promise((resolve) => resolve(work()));

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

export class DaemonChats implements ChatBackend {
  private push: (agentId: string, conversationId: string, events: ChatEvent[]) => void = () => {};
  private readonly deps: Deps;
  private readonly loki: LokiEngine;
  private readonly acpEngine: AcpEngine | null;

  private readonly colors: LabelColors;
  private readonly capped = keyedQueue();

  constructor(deps: Deps) {
    this.deps = deps;
    this.colors = new LabelColors(deps.labelsFile);
    const push = (agentId: string, conversationId: string, events: ChatEvent[]) => this.push(agentId, conversationId, events);
    this.loki = new LokiEngine({ ...deps, push });
    this.acpEngine = deps.acp ? new AcpEngine({ acp: deps.acp, context: deps.context, push }) : null;
    deps.stores.onOpen((agentId) => this.loki.forgetAgent(agentId));
  }

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

  private async started(chat: Conversation): Promise<boolean> {
    const page = await chat.entries({ order: "ascending" }, 50, undefined, this.deps.context);
    return page.items.some((e) => e.kind === "pi.user" || e.kind === "pi.assistant");
  }

  private async resolve(agentId: string, conversationId: string): Promise<{ c: EngineChat; engine: Engine }> {
    const found = await this.find(agentId, conversationId);
    if (!found) throw new Error(`no chat ${conversationId} for ${agentId}`);
    return found;
  }

  private async find(agentId: string, conversationId: string): Promise<{ c: EngineChat; engine: Engine } | null> {
    const store = await this.deps.stores.get(agentId);
    const chat = await store.chat(conversationId, this.deps.context);
    if (!chat) return null;
    const saved = (await store.chatInfo(chat.id, this.deps.context))?.engine;
    const onAcp = saved?.kind === "acp" && this.acpEngine ? { saved, engine: this.acpEngine } : null;
    return { c: { agentId, conversationId, store, chat, engine: onAcp?.saved ?? null }, engine: onAcp?.engine ?? this.loki };
  }

  async open(agentId: string, conversationId: string, mode: string | null = null): Promise<ChatState> {
    const { c, engine } = await this.resolve(agentId, conversationId);
    const state = await engine.open(c, mode);
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

  async power(agentId: string, conversationId: string): Promise<PermissionMode | null> {
    const { c } = await this.resolve(agentId, conversationId);
    if (c.engine) return lokiModeOf((await this.acp.state(agentId, conversationId)).mode, true);
    const info = await c.store.chatInfo(c.chat.id, this.deps.context);
    const own = modeOf(info?.mode);
    return info?.turn_cap ? stricterMode(own, lokiModeOf(info.turn_cap, false)) : own;
  }

  async sendHeld(p: PayloadOf<"chat_send">, cap: PermissionMode | null): Promise<string | null> {
    const { c, engine } = await this.resolve(p.agent_id, p.conversation_id);
    if (c.engine) {
      // Outside (ACP): an agent's mode cannot be lowered for one turn, so a chat whose mode has more power is refused instead.
      const mode = lokiModeOf((await this.acp.state(p.agent_id, p.conversation_id)).mode, true);
      if (looserThan(mode, cap ?? UNKNOWN_CAP))
        return "that chat runs in a mode with more power than the chat that sent this: lower its mode, or ask the person";
      await engine.send(c, p);
      return null;
    }
    await this.capped(`${p.agent_id}\u0000${p.conversation_id}`, async () => {
      const held = (await c.store.chatInfo(c.chat.id, this.deps.context))?.turn_cap;
      const next = held ? stricterMode(lokiModeOf(held, false), cap) : (cap ?? UNKNOWN_CAP);
      await c.store.updateChat(p.conversation_id, { turn_cap: next }, this.deps.context);
      await engine.send(c, p);
    });
    return null;
  }

  answer(p: PayloadOf<"chat_answer">): Promise<boolean> {
    return settled(() => this.deps.approvals.answer(p.question_id, p.input));
  }

  async busy(agentId: string, conversationId: string): Promise<boolean> {
    const found = await this.find(agentId, conversationId);
    return found ? found.engine.busy(found.c) : false;
  }

  async create(agentId: string, cwd: string | null, title: string | null, home: string | null = null): Promise<{ agentId: string; conversationId: string }> {
    const store = await this.deps.stores.get(agentId);
    const conversationId = `local-conv-${randomUUID()}`;
    const model = modelRef(readLocalAgent(agentId, this.deps.backendDir)?.model ?? "");
    await store.createChat(conversationId, { title, agent: { ...(model ? { model } : {}), ...(cwd ? { cwd } : {}) } }, this.deps.context);
    const here = this.deps.macId ?? "";
    if (home && here && homeOf(readRecord(this.deps.backendDir, agentId), here) !== here)
      await store.updateChat(conversationId, { placed: true }, this.deps.context);
    const usual = this.deps.usualModel?.(agentId);
    if (usual)
      await this.model({ agent_id: agentId, conversation_id: conversationId, handle: usual.handle, reasoning_effort: usual.reasoning_effort }).catch(
        (e: unknown) => this.deps.report?.(`a new chat could not start on ${usual.handle}: ${messageOf(e)}`),
      );
    return { agentId, conversationId };
  }

  async send(p: PayloadOf<"chat_send">): Promise<boolean> {
    const { c, engine } = await this.resolve(p.agent_id, p.conversation_id);
    await this.capped(`${p.agent_id}\u0000${p.conversation_id}`, async () => {
      if (!c.engine && (await c.store.chatInfo(c.chat.id, this.deps.context))?.turn_cap && !(await engine.busy(c)))
        await c.store.updateChat(p.conversation_id, { turn_cap: null }, this.deps.context);
      await engine.send(c, p);
    });
    if ((await c.store.chatInfo(c.chat.id, this.deps.context))?.draft) await c.store.updateChat(p.conversation_id, { draft: null }, this.deps.context);
    return true;
  }

  async deliver(agentId: string, conversationId: string, text: string, whenBusy: "steer" | "followUp" = "followUp"): Promise<Delivery | null> {
    const { c, engine } = await this.resolve(agentId, conversationId);
    return engine.deliver(c, `${text}\n\n${daemonTimeReminder(new Date((this.deps.now ?? Date.now)()))}`, whenBusy);
  }

  async abort(agentId: string, conversationId: string): Promise<void> {
    const { c, engine } = await this.resolve(agentId, conversationId);
    await engine.abort(c);
  }

  async update(p: PayloadOf<"chat_update">): Promise<Replies["chat_done"]> {
    const store = await this.deps.stores.get(p.agent_id);
    if (p.draft) {
      const saved = await store.saveDraft(p.conversation_id, p.draft, this.deps.context);
      if (saved === "missing") throw new Error(`no chat ${p.conversation_id}`);
      if (saved === "held") throw new Error(DRAFT_HELD);
    }
    const change = {
      ...(p.title !== undefined ? { title: p.title } : {}),
      ...(p.archived !== undefined ? { archived: p.archived } : {}),
      ...(p.hidden !== undefined ? { hidden: p.hidden } : {}),
      ...(p.labels !== undefined ? { labels: p.labels } : {}),
      ...(p.purpose !== undefined ? { purpose: p.purpose } : {}),
      ...(p.draft === null ? { draft: null } : {}),
    };
    if (!(await store.updateChat(p.conversation_id, change, this.deps.context))) throw new Error(`no chat ${p.conversation_id}`);
    for (const label of p.labels ?? []) this.colors.colorOf(label);
    return p.draft ? { draft_suggestion_id: p.draft.suggestion_id } : {};
  }

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
    const file = join(this.deps.backendDir, "agents", `${backendName(id)}.json`);
    writeRecord(this.deps.backendDir, id, stamp(JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>, SYNCED_FIELDS, this.stampNow()));
    const store = await this.deps.stores.get(id);
    await store.setAgent({ id, name: p.name }, this.deps.context);
    const model = p.model ? modelRef(p.model) : undefined;
    await store.createChat(MAIN_CHAT_ID, { agent: model ? { model } : {} }, this.deps.context);
    return { id, name: p.name };
  }

  async updateAgent(p: PayloadOf<"chat_agent_update">): Promise<void> {
    const file = join(this.deps.backendDir, "agents", `${backendName(p.agent_id)}.json`);
    const record = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    const changed = (["name", "description", "model", "home_mac"] as const).filter((f) => p[f] !== undefined);
    for (const f of changed) record[f] = p[f];
    const cleared = p.advisor_model === null;
    const advisor = (["advisor_model", "advisor_reasoning_effort"] as const).filter((f) => cleared || p[f] !== undefined);
    for (const f of advisor) record[f] = cleared ? undefined : (p[f] ?? undefined);
    writeRecord(this.deps.backendDir, p.agent_id, stamp(record, [...changed, ...advisor], this.stampNow()));
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

  async runLearn(): Promise<void> {
    if (!this.deps.passes) throw new Error("the background passes are not running");
    await this.deps.passes.runner.runAllNow("learn");
  }

  async command(p: PayloadOf<"chat_command">): Promise<{ success: boolean; output: string }> {
    const { c, engine } = await this.resolve(p.agent_id, p.conversation_id);
    switch (p.command) {
      case "reflect":
        if (!this.deps.passes) return { success: false, output: "reflection is not running" };
        void this.deps.passes.runner.runNow("reflection", p.agent_id, p.conversation_id).catch(() => {});
        return { success: true, output: "reflecting on this chat; its memory changes show on the agent's page" };
      case "doctor": {
        if (!this.deps.passes) return { success: false, output: "the background passes are not running" };
        const r = await this.deps.passes.runner.runDoctor(p.agent_id);
        const tail = r.changes
          ? `\n\n${r.changes} change${r.changes === 1 ? "" : "s"} committed by Doctor; Agents › Changes shows each, and Revert undoes one.`
          : "";
        return { success: r.outcome !== "failed" && r.outcome !== "skipped", output: `${r.report}${tail}` };
      }
      default:
        return engine.command(c, p);
    }
  }

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

  async revertMemory(p: PayloadOf<"chat_memory_revert">): Promise<void> {
    await revertMemoryCommit(this.deps.backendDir, p.agent_id, p.sha);
  }

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

  async exportChat(agentId: string, chatId: string): Promise<{ chat: MovedChat | null; busy: boolean }> {
    if (await this.busy(agentId, chatId)) return { chat: null, busy: true };
    const store = await this.deps.stores.get(agentId);
    const schedules = (this.deps.schedules?.list() ?? []).filter((t) => t.status === "active" && t.agent_id === agentId && t.conversation_id === chatId);
    const cursors: Record<string, number> = {};
    for (const job of ["reflection", "learn"] as const) {
      const at = this.deps.passes?.state.cursor(job, agentId, chatId);
      if (at !== undefined) cursors[job] = at;
    }
    return { chat: await exportChat(store, agentId, chatId, { schedules, cursors }, this.deps.context), busy: false };
  }

  async importChat(moved: MovedChat, names?: MoveNames): Promise<boolean> {
    const store = await this.deps.stores.get(moved.agent_id);
    const made = await importChat(store, moved, this.deps.context, names);
    if (made) await this.loki.forgetChat(moved.agent_id, moved.conversation_id);
    for (const task of moved.schedules) this.deps.schedules?.adopt(task);
    for (const [job, at] of Object.entries(moved.cursors))
      if (job === "reflection" || job === "learn") this.deps.passes?.state.setCursor(job, moved.agent_id, moved.conversation_id, at);
    return made;
  }

  async finishMove(agentId: string, chatId: string): Promise<void> {
    const store = await this.deps.stores.get(agentId);
    await store.updateChat(chatId, { hidden: true }, this.deps.context);
    for (const t of this.deps.schedules?.list() ?? [])
      if (t.status === "active" && t.agent_id === agentId && t.conversation_id === chatId) this.deps.schedules?.cancel(agentId, t.id);
  }

  labelColors(): LabelColorsSnapshot {
    return this.colors.snapshot();
  }

  applyLabelColors(theirs: LabelColorsSnapshot): boolean {
    return this.colors.apply(theirs);
  }

  async deleteAgent(agentId: string): Promise<void> {
    addTombstone(this.deps.backendDir, { id: agentId, ...this.stampNow() });
    await this.removeAgent(agentId);
  }

  async removeAgent(agentId: string): Promise<void> {
    this.deps.schedules?.cancelAgent(agentId);
    this.deps.background?.stopAgent(agentId);
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
