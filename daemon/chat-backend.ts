import type { Context } from "@earendil-works/chord";
import type { Models } from "@earendil-works/pi-ai/models";
import { LiveDoc, watchEvents, type Conversation } from "@earendil-works/pi-durable";
import { randomUUID } from "node:crypto";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { ChatEvent } from "../core/attention/model.ts";
import { backendName } from "../core/desk-core.ts";
import type { ChatState, PayloadOf } from "../core/frames.ts";
import type { ModelEntry, ReasoningEffort } from "../core/models.ts";
import { readLocalAgent } from "../mod/agents.ts";
import type { ChatBackend } from "../mod/frames/chat.ts";
import { ChatEventConverter } from "./chat-events.ts";
import { isPermissionMode, type Approvals } from "./approvals.ts";
import type { AgentStore } from "./kernel/index.ts";
import type { StoreManager } from "./kernel/stores.ts";
import type { ModRegistry } from "./mods/registry.ts";
import { createAgent, listAgents, writeRecord } from "./store/agents.ts";

/**
 * Chats on loki's daemon, as the mod's chat frames ask for them (plan 017, U5; mod/frames/chat.ts). A chat a client
 * opens is followed through pi-durable's event stream, converted to loki's chat events and pushed to every socket.
 * The person's message passes through every mod's transform before it is sent (loki's own adds what you did on the
 * canvas), and a message sent while the chat is busy waits its turn, as on Letta.
 */

type Deps = {
  stores: StoreManager;
  approvals: Approvals;
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
    const key = `${agentId}\u0000${conversationId}`;
    if (!this.watching.has(key)) this.watching.set(key, this.follow(store, chat, agentId, conversationId));
    await this.watching.get(key);
    const state = await this.state(store, chat, agentId, conversationId);
    // What the chat is waiting on reaches a client that opens it late, after the state it opens with.
    const waiting = this.deps.approvals.waitingIn(agentId, conversationId);
    if (waiting.length) queueMicrotask(() => this.push(agentId, conversationId, waiting));
    return state;
  }

  async approve(p: PayloadOf<"chat_approve">): Promise<boolean> {
    return this.deps.approvals.decide(p.requestId, p.allow, p.message ?? undefined);
  }

  async answer(p: PayloadOf<"chat_answer">): Promise<boolean> {
    return this.deps.approvals.answer(p.requestId, p.input);
  }

  /** Push every event of a chat from now on. */
  private async follow(store: AgentStore, chat: Conversation, agentId: string, conversationId: string): Promise<void> {
    const stream = await watchEvents(store.harness, chat.id, this.deps.context);
    const converter = new ChatEventConverter();
    stream.start(async (batch) => {
      const events = batch.flatMap((ev) => converter.convert(ev));
      if (events.length) this.push(agentId, conversationId, events);
    });
  }

  private async state(store: AgentStore, chat: Conversation, agentId: string, conversationId: string): Promise<ChatState> {
    const [view, settings] = await Promise.all([store.harness.snapshot(LiveDoc, chat.id, this.deps.context), store.agentSettings(chat.id, this.deps.context)]);
    const info = await store.chatInfo(chat.id, this.deps.context);
    const waiting = this.deps.approvals.waitingIn(agentId, conversationId).length > 0;
    return { agentId, conversationId, loop: waiting ? "approval" : view?.run ? "running" : "idle", mode: isPermissionMode(info?.mode) ? info.mode : "unrestricted", cwd: (settings as { cwd?: string } | undefined)?.cwd ?? null };
  }

  async create(agentId: string, cwd: string | null, title: string | null): Promise<{ agentId: string; conversationId: string }> {
    const store = await this.deps.stores.get(agentId);
    const conversationId = `local-conv-${randomUUID()}`;
    const model = modelRef(readLocalAgent(agentId, this.deps.backendDir)?.model ?? "");
    await store.createChat(conversationId, { title, agent: { ...(model ? { model } : {}), ...(cwd ? { cwd } : {}) } }, this.deps.context);
    return { agentId, conversationId };
  }

  async send(p: PayloadOf<"chat_send">): Promise<boolean> {
    const { chat } = await this.chat(p.agentId, p.conversationId);
    const images = p.images.map((i) => ({ type: "image" as const, data: i.data, mimeType: i.mediaType }));
    const parts = [...(p.context ? [{ type: "text" as const, text: p.context }] : []), ...(p.text.trim() ? [{ type: "text" as const, text: p.text }] : []), ...images];
    const agentName = readLocalAgent(p.agentId, this.deps.backendDir)?.name ?? "";
    const content = this.deps.mods.transformMessage({ chatId: p.conversationId, agentId: p.agentId, agentName, content: parts.length === 1 && parts[0].type === "text" ? parts[0].text : parts, typed: p.text.trim() !== "" });
    await chat.submit({ type: "input", content: content as never, ...(p.sendId ? { requestId: p.sendId } : {}) }, this.deps.context);
    return true;
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
    const id = await createAgent(this.deps.backendDir, { name: p.name, ...(p.description ? { description: p.description } : {}), ...(p.model ? { model: p.model } : {}) });
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

  async deleteAgent(agentId: string): Promise<void> {
    await this.deps.stores.close(agentId);
    for (const path of [this.deps.stores.file(agentId), `${this.deps.stores.file(agentId)}-wal`, `${this.deps.stores.file(agentId)}-shm`, join(this.deps.backendDir, "memfs", agentId), join(this.deps.backendDir, "agents", `${backendName(agentId)}.json`)]) {
      rmSync(path, { recursive: true, force: true });
    }
  }
}
