import type { Context } from "@earendil-works/chord";
import type { Models } from "@earendil-works/pi-ai/models";
import { LiveDoc, watchEvents, type Conversation } from "@earendil-works/pi-durable";
import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync, symlinkSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { globalSkillsDir } from "../mod/skills.ts";
import type { ChatEvent } from "../core/attention/model.ts";
import { backendName } from "../core/desk-core.ts";
import type { ChatState, PayloadOf } from "../core/frames.ts";
import type { ModelEntry, ReasoningEffort } from "../core/models.ts";
import { readLocalAgent } from "../mod/agents.ts";
import type { ChatBackend } from "../mod/frames/chat.ts";
import { ChatEventConverter } from "./chat-events.ts";
import { turnIdOf } from "./telemetry.ts";
import { piHandle } from "./model-handle.ts";
import { isPermissionMode, type Approvals } from "./approvals.ts";
import type { Providers } from "./providers.ts";
import type { PassRunner } from "./passes.ts";
import type { PassState } from "./passes-state.ts";
import { editMemoryFile } from "./memory.ts";
import type { AgentStore } from "./kernel/index.ts";
import type { StoreManager } from "./kernel/stores.ts";
import type { ModRegistry } from "./mods/registry.ts";
import { createAgent, listAgents, writeRecord } from "./store/agents.ts";

/**
 * Chats on loki's daemon, as the mod's chat frames ask for them (plan 017, U5; mod/frames/chat.ts). A chat a client
 * opens is followed through pi-durable's event stream, converted to loki's chat events and pushed to every socket.
 * The person's message passes through every mod's transform before it is sent (loki's own adds what you did on the
 * canvas), and a message sent while the chat is busy waits its turn.
 */

type Deps = {
  stores: StoreManager;
  approvals: Approvals;
  providers: Providers;
  /** The background passes (daemon/passes.ts): reflection and Learn. Absent in tests that run none. */
  passes?: { runner: PassRunner; state: PassState };
  mods: ModRegistry;
  models: Models;
  /** The daemon's agents, in Letta's backend layout (daemon/store/agents.ts). */
  backendDir: string;
  context: Context;
  report?: (message: string) => void;
};

/** A model handle (`provider/model`) as pi-durable's model reference. */
export function modelRef(handle: string): { provider: string; modelId: string } | undefined {
  const slash = handle.indexOf("/");
  return slash > 0 && slash < handle.length - 1 ? { provider: handle.slice(0, slash), modelId: handle.slice(slash + 1) } : undefined;
}

/** loki's reasoning effort as pi's thinking level. */
function thinkingLevel(effort: ReasoningEffort | null): string | undefined {
  if (!effort) return undefined;
  return effort === "none" ? "off" : effort === "max" ? "xhigh" : effort;
}

export class DaemonChats implements ChatBackend {
  private push: (agentId: string, conversationId: string, events: ChatEvent[]) => void = () => {};
  private readonly watching = new Map<string, Promise<void>>();
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
  }

  private async chat(agentId: string, conversationId: string): Promise<{ store: AgentStore; chat: Conversation }> {
    const store = await this.deps.stores.get(agentId);
    const chat = await store.chat(conversationId, this.deps.context);
    if (!chat) throw new Error(`no chat ${conversationId} for ${agentId}`);
    return { store, chat };
  }

  async open(agentId: string, conversationId: string, mode: string | null = null): Promise<ChatState> {
    const { store, chat } = await this.chat(agentId, conversationId);
    if (mode !== null) {
      if (!isPermissionMode(mode)) throw new Error(`not a permission mode: ${mode}`);
      await store.updateChat(conversationId, { mode }, this.deps.context);
    }
    await this.watch(store, chat, agentId, conversationId);
    const state = await this.state(store, chat, agentId, conversationId);
    // What the chat is waiting on reaches a client that opens it late, after the state it opens with.
    const waiting = this.deps.approvals.waitingIn(agentId, conversationId);
    if (waiting.length) queueMicrotask(() => this.push(agentId, conversationId, waiting));
    return state;
  }

  async approve(p: PayloadOf<"chat_approve">): Promise<boolean> {
    return this.deps.approvals.decide(p.approvalId, p.allow, p.message ?? undefined);
  }

  async answer(p: PayloadOf<"chat_answer">): Promise<boolean> {
    return this.deps.approvals.answer(p.questionId, p.input);
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
    stream.start(async (batch) => {
      const events = batch.flatMap((ev) => converter.convert(ev));
      if (events.length) this.push(agentId, conversationId, events);
    });
  }

  /** Whether a turn is running in a chat, or waits on the person (the background passes leave such a chat alone). */
  async busy(agentId: string, conversationId: string): Promise<boolean> {
    const store = await this.deps.stores.get(agentId);
    const chat = await store.chat(conversationId, this.deps.context);
    if (!chat) return false;
    if (this.deps.approvals.waitingIn(agentId, conversationId).length > 0) return true;
    return Boolean((await store.harness.snapshot(LiveDoc, chat.id, this.deps.context))?.run);
  }

  private async state(store: AgentStore, chat: Conversation, agentId: string, conversationId: string): Promise<ChatState> {
    const [view, settings] = await Promise.all([store.harness.snapshot(LiveDoc, chat.id, this.deps.context), store.agentSettings(chat.id, this.deps.context)]);
    const info = await store.chatInfo(chat.id, this.deps.context);
    const waiting = this.deps.approvals.waitingIn(agentId, conversationId).length > 0;
    return { agentId, conversationId, loop: waiting ? "approval" : view?.run ? "running" : "idle", turnId: view?.run ? turnIdOf(agentId, view.run.inputs) : null, mode: isPermissionMode(info?.mode) ? info.mode : "unrestricted", cwd: (settings as { cwd?: string } | undefined)?.cwd ?? null };
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
    const { store, chat } = await this.chat(p.agentId, p.conversationId);
    await this.healModel(store, chat);
    await this.watch(store, chat, p.agentId, p.conversationId);
    const images = p.images.map((i) => ({ type: "image" as const, data: i.data, mimeType: i.mediaType }));
    const parts = [...(p.context ? [{ type: "text" as const, text: p.context }] : []), ...(p.text.trim() ? [{ type: "text" as const, text: p.text }] : []), ...images];
    const agentName = readLocalAgent(p.agentId, this.deps.backendDir)?.name ?? "";
    const content = this.deps.mods.transformMessage({ chatId: p.conversationId, agentId: p.agentId, agentName, content: parts.length === 1 && parts[0].type === "text" ? parts[0].text : parts, typed: p.text.trim() !== "" });
    await chat.submit({ type: "input", content: content as never, ...(p.sendId ? { requestId: p.sendId } : {}) }, this.deps.context);
    return true;
  }

  /** A message from loki itself (a finished background task, a scheduled prompt): it waits its turn like yours. */
  async deliver(agentId: string, conversationId: string, text: string): Promise<void> {
    const { store, chat } = await this.chat(agentId, conversationId);
    await this.healModel(store, chat);
    await this.watch(store, chat, agentId, conversationId);
    await chat.submit({ type: "input", content: text }, this.deps.context);
  }

  /**
   * Learn's ask: the prompt in a hidden chat, made on first use in the home folder, the agent's whole reply back. The
   * chat is compacted after each ask so the next starts from a summary, and reflection leaves it alone
   * (daemon/reflection.ts).
   */
  async ask(agentId: string, conversationId: string, prompt: string, model: string | null): Promise<string> {
    const store = await this.deps.stores.get(agentId);
    const ref = modelRef(model ?? readLocalAgent(agentId, this.deps.backendDir)?.model ?? "");
    let chat = await store.chat(conversationId, this.deps.context);
    if (!chat) chat = await store.createChat(conversationId, { title: "recall", hidden: true, agent: { cwd: homedir(), ...(ref ? { model: ref } : {}) } }, this.deps.context);
    else if (ref) await chat.configure({ model: ref }, this.deps.context);
    const settled = await (await chat.submit({ type: "input", content: prompt }, this.deps.context)).wait(this.deps.context);
    if (settled.status !== "done") throw new Error(`the agent did not answer: ${settled.status}`);
    let reply = "";
    for (const entry of await store.entries(chat, this.deps.context)) {
      const m = entry.model?.[0] as { role?: string; content?: Array<{ type?: string; text?: string }> } | undefined;
      if (entry.kind !== "pi.assistant" || m?.role !== "assistant") continue;
      const text = (m.content ?? []).filter((p) => p.type === "text").map((p) => p.text).join("").trim();
      if (text) reply = text;
    }
    // A compaction that fails only means the next ask carries this one too.
    await chat.compact(undefined, this.deps.context).catch((e: unknown) => this.deps.report?.(`recall compaction failed: ${String(e)}`));
    return reply;
  }

  async abort(agentId: string, conversationId: string): Promise<void> {
    await (await this.chat(agentId, conversationId)).chat.abort(this.deps.context);
  }

  async update(p: PayloadOf<"chat_update">): Promise<void> {
    const store = await this.deps.stores.get(p.agentId);
    const change = { ...(p.title !== undefined ? { title: p.title } : {}), ...(p.archived !== undefined ? { archived: p.archived } : {}), ...(p.hidden !== undefined ? { hidden: p.hidden } : {}) };
    if (!(await store.updateChat(p.conversationId, change, this.deps.context))) throw new Error(`no chat ${p.conversationId}`);
  }

  async folder(agentId: string, conversationId: string, cwd: string): Promise<ChatState> {
    const { store, chat } = await this.chat(agentId, conversationId);
    await chat.configure({ cwd }, this.deps.context);
    this.push(agentId, conversationId, [{ kind: "device", cwd }]);
    return this.state(store, chat, agentId, conversationId);
  }

  async model(p: PayloadOf<"chat_model">): Promise<void> {
    const { chat } = await this.chat(p.agentId, p.conversationId);
    const model = modelRef(p.handle);
    if (!model) throw new Error(`not a model handle: ${p.handle}`);
    const level = thinkingLevel(p.reasoningEffort);
    await chat.configure({ model, ...(level ? { thinkingLevel: level as never } : {}) }, this.deps.context);
  }

  async models(): Promise<ModelEntry[]> {
    const available = await this.deps.models.getAvailable();
    return available.map((m) => ({ id: `${m.provider}/${m.id}`, handle: `${m.provider}/${m.id}`, label: m.name || m.id }));
  }

  async agents(): Promise<Array<{ id: string; name: string }>> {
    return listAgents(this.deps.backendDir).map((id) => ({ id, name: readLocalAgent(id, this.deps.backendDir)?.name ?? id }));
  }

  async createAgent(p: PayloadOf<"chat_agent_create">): Promise<{ id: string; name: string }> {
    const id = await createAgent(this.deps.backendDir, { name: p.name, ...(p.description ? { description: p.description } : {}), ...(p.persona ? { persona: p.persona } : {}), ...(p.model ? { model: p.model } : {}) });
    const store = await this.deps.stores.get(id);
    await store.setAgent({ id, name: p.name }, this.deps.context);
    const model = p.model ? modelRef(p.model) : undefined;
    await store.createChat("default", { agent: model ? { model } : {} }, this.deps.context);
    return { id, name: p.name };
  }

  async updateAgent(p: PayloadOf<"chat_agent_update">): Promise<void> {
    const file = join(this.deps.backendDir, "agents", `${backendName(p.agentId)}.json`);
    const record = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    if (p.name !== undefined) record.name = p.name;
    if (p.description !== undefined) record.description = p.description;
    if (p.model !== undefined) record.model = p.model;
    writeRecord(this.deps.backendDir, p.agentId, record);
    if (p.name !== undefined) await (await this.deps.stores.get(p.agentId)).setAgent({ id: p.agentId, name: p.name }, this.deps.context);
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

  async passes() {
    if (!this.deps.passes) throw new Error("the background passes are not running");
    return this.deps.passes.state.settings();
  }

  async setPasses(s: PayloadOf<"chat_passes_set">) {
    if (!this.deps.passes) throw new Error("the background passes are not running");
    return this.deps.passes.state.setSettings(s);
  }

  /** Learn's "Run now": every settled chat it has new material in, whether Learn is on or not. */
  async runLearn(): Promise<void> {
    if (!this.deps.passes) throw new Error("the background passes are not running");
    await this.deps.passes.runner.runAllNow("learn");
  }

  /** The slash commands the daemon runs: /compact [instructions], /clear, /remember [what], /reflect. */
  async command(p: PayloadOf<"chat_command">): Promise<{ success: boolean; output: string }> {
    const { chat } = await this.chat(p.agentId, p.conversationId);
    switch (p.command) {
      case "compact":
        await chat.compact(p.args?.trim() || undefined, this.deps.context);
        return { success: true, output: "summarising the conversation so far" };
      case "clear":
        await chat.reset(undefined, this.deps.context);
        return { success: true, output: "the agent starts this chat afresh; what was said stays in the thread" };
      case "remember": {
        const what = p.args?.trim();
        const text = what ? `Please remember this in your memory: ${what}` : "Look back over this conversation and save to your memory whatever is worth keeping.";
        await chat.submit({ type: "input", content: text }, this.deps.context);
        return { success: true, output: "asked the agent to remember" };
      }
      case "reflect":
        if (!this.deps.passes) return { success: false, output: "reflection is not running" };
        // The pass runs on its own, even with reflection off; its memory changes show on the agent's page when it is done.
        void this.deps.passes.runner.runNow("reflection", p.agentId, p.conversationId).catch(() => {});
        return { success: true, output: "reflecting on this chat; its memory changes show on the agent's page" };
      default:
        return { success: false, output: `/${p.command} is not a command loki's daemon runs` };
    }
  }

  /** A skill made global: a link to its folder in the global skills folder, ~/.agents/skills (mod/skills.ts). */
  async enableSkill(path: string): Promise<{ name: string; linkPath: string }> {
    if (!existsSync(join(path, "SKILL.md"))) throw new Error(`${path} has no SKILL.md`);
    const dir = globalSkillsDir();
    mkdirSync(dir, { recursive: true });
    const name = basename(path);
    const linkPath = join(dir, name);
    if (existsSync(linkPath)) throw new Error(`a global skill named ${name} is already there`);
    symlinkSync(path, linkPath, "dir");
    return { name, linkPath };
  }

  async disableSkill(name: string): Promise<void> {
    const linkPath = join(globalSkillsDir(), name);
    if (!lstatSync(linkPath, { throwIfNoEntry: false })?.isSymbolicLink()) throw new Error(`${name} is not a linked global skill`);
    unlinkSync(linkPath);
  }

  async writeMemory(p: PayloadOf<"chat_memory_write">): Promise<void> {
    await editMemoryFile(this.deps.backendDir, p.agentId, p.path, p.content, p.message);
  }

  async deleteAgent(agentId: string): Promise<void> {
    await this.deps.stores.close(agentId);
    for (const path of [this.deps.stores.file(agentId), `${this.deps.stores.file(agentId)}-wal`, `${this.deps.stores.file(agentId)}-shm`, join(this.deps.backendDir, "memfs", agentId), join(this.deps.backendDir, "agents", `${backendName(agentId)}.json`)]) {
      rmSync(path, { recursive: true, force: true });
    }
  }
}
