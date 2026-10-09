import type { AppliedModel, ModelEntry, ModelSelection } from "../models.ts";
import type { InputOf, ReplyOf, RequestName, RequestResult } from "../frames.ts";
import type { ImageAttachment } from "./content.ts";
import type { ChatEvent } from "./model.ts";
import type { AppServerSocket, ConnectProvider, Personality, ReflectionMerge, ReflectionSettings, ReflectionTrigger, Runtime, ServerEvent } from "./protocol.ts";

/**
 * What the attention model (useAttention) talks to for a chat's live half (plan 017, U5): Letta's app-server through
 * AppServerSocket, or loki's daemon through the mod's own frames (FrameChatClient). Events arrive as loki's chat
 * events either way.
 */
export type ChatClient = Pick<
  AppServerSocket,
  | "abortTurn"
  | "answerQuestion"
  | "changeFolder"
  | "connectProvider"
  | "createAgent"
  | "createConversation"
  | "deleteAgent"
  | "deleteMemoryFile"
  | "disconnectProvider"
  | "executeCommand"
  | "getReflectionSettings"
  | "isSubscribed"
  | "listAgents"
  | "listConnectProviders"
  | "listMessages"
  | "listModels"
  | "renameConversation"
  | "respondApproval"
  | "runtimeStart"
  | "sendUserMessage"
  | "setReflectionSettings"
  | "skillDisable"
  | "skillEnable"
  | "updateAgent"
  | "updateConversation"
  | "updateModel"
  | "writeMemoryFile"
  | "close"
> & {
  onStatus?: (s: "connecting" | "open" | "closed") => void;
  /** Every chat event, with the chat it happened in. */
  onChat(fn: (rt: Runtime, events: ChatEvent[]) => void): () => void;
  /** Which backend this is, for Settings. */
  serverInfo(): Promise<{ version: string | null; protocol: number | null; commands?: string[]; modCommands?: Array<{ id: string; description?: string; args?: string }> }>;
};

/** The mod socket's request, as the app's useDesk makes it. */
export type FrameRequest = <N extends RequestName>(type: N, payload: InputOf<N>, timeoutMs: number) => Promise<RequestResult<ReplyOf<N>>>;

const NOT_YET = (what: string) => new Error(`${what} is not on loki's daemon yet`);

/**
 * loki's daemon, through the mod's frames (core/frames.ts chat_*). A chat is named by its agent and id on the wire;
 * the attention model sometimes names it by id alone (archiving from the sidebar), so the client remembers each
 * chat's agent as it meets it, and asks `agentOf` for the rest.
 */
export class FrameChatClient implements ChatClient {
  onStatus?: (s: "connecting" | "open" | "closed") => void;
  private readonly request: FrameRequest;
  private readonly agentOf: (conversationId: string) => string | null;
  private readonly unsubscribe: () => void;
  private readonly listeners = new Set<(rt: Runtime, events: ChatEvent[]) => void>();
  private readonly opened = new Set<string>();
  private readonly agents = new Map<string, string>();

  constructor(opts: { request: FrameRequest; onChatEvent: (fn: (p: { agentId: string; conversationId: string; events: ChatEvent[] }) => void) => () => void; agentOf?: (conversationId: string) => string | null }) {
    this.request = opts.request;
    this.agentOf = opts.agentOf ?? (() => null);
    this.unsubscribe = opts.onChatEvent(({ agentId, conversationId, events }) => this.emit({ agent_id: agentId, conversation_id: conversationId }, events));
    queueMicrotask(() => this.onStatus?.("open"));
  }

  private emit(rt: Runtime, events: ChatEvent[]): void {
    for (const fn of this.listeners) fn(rt, events);
  }

  private async call<N extends RequestName>(type: N, payload: InputOf<N>, timeoutMs = 15_000): Promise<ReplyOf<N>> {
    const r = await this.request(type, payload, timeoutMs);
    if (!r.ok) throw new Error(r.error);
    return r.reply;
  }

  private remember(rt: Runtime): Runtime {
    this.agents.set(rt.conversation_id, rt.agent_id);
    return rt;
  }

  private agentFor(conversationId: string): string {
    const agentId = this.agents.get(conversationId) ?? this.agentOf(conversationId);
    if (!agentId) throw new Error(`which agent's chat is ${conversationId}?`);
    return agentId;
  }

  onChat(fn: (rt: Runtime, events: ChatEvent[]) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  async serverInfo() {
    return { version: "loki daemon", protocol: null };
  }

  close(): void {
    this.unsubscribe();
    this.listeners.clear();
  }

  isSubscribed(rt: Runtime): boolean {
    return this.opened.has(`${rt.agent_id}\u0000${rt.conversation_id}`);
  }

  /** Open a chat: its live events follow, and its state now arrives as events too. */
  async runtimeStart(rt: Runtime, opts: { mode?: string } = {}): Promise<ServerEvent> {
    this.remember(rt);
    const state = await this.call("chat_open", { agentId: rt.agent_id, conversationId: rt.conversation_id, mode: opts.mode ?? null });
    this.opened.add(`${rt.agent_id}\u0000${rt.conversation_id}`);
    this.emit(rt, [{ kind: "loop", state: state.loop }, { kind: "device", ...(state.mode ? { mode: state.mode } : {}), ...(state.cwd ? { cwd: state.cwd } : {}) }]);
    return { type: "chat_state" };
  }

  async createConversation(agentId: string, cwd: string, name?: string): Promise<Runtime> {
    const created = await this.call("chat_create", { agentId, cwd, title: name ?? null });
    const rt = this.remember({ agent_id: created.agentId, conversation_id: created.conversationId });
    await this.runtimeStart(rt);
    return rt;
  }

  async sendUserMessage(rt: Runtime, text: string, images: ImageAttachment[] = [], context?: string): Promise<boolean> {
    this.remember(rt);
    const sendId = `send-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const r = await this.call("chat_send", { agentId: rt.agent_id, conversationId: rt.conversation_id, text, images: images.map((i) => ({ mediaType: i.mediaType, data: i.data })), sendId, context: context ?? null });
    return r.accepted;
  }

  async abortTurn(rt: Runtime): Promise<boolean> {
    await this.call("chat_abort", { agentId: rt.agent_id, conversationId: rt.conversation_id });
    return true;
  }

  async changeFolder(rt: Runtime, cwd: string): Promise<void> {
    await this.call("chat_folder", { agentId: rt.agent_id, conversationId: rt.conversation_id, cwd });
  }

  async updateConversation(conversationId: string, body: Record<string, unknown>): Promise<void> {
    await this.call("chat_update", {
      agentId: this.agentFor(conversationId),
      conversationId,
      ...(typeof body.summary === "string" || body.summary === null ? { title: body.summary as string | null } : {}),
      ...(typeof body.archived === "boolean" ? { archived: body.archived } : {}),
      ...(typeof body.hidden === "boolean" ? { hidden: body.hidden } : {}),
    } as InputOf<"chat_update">);
  }

  async renameConversation(conversationId: string, name: string): Promise<void> {
    await this.updateConversation(conversationId, { summary: name });
  }

  async updateModel(rt: Runtime, choice: ModelSelection | string): Promise<AppliedModel> {
    const handle = typeof choice === "string" ? choice : choice.handle;
    const reasoningEffort = typeof choice === "string" ? null : (choice.reasoningEffort ?? null);
    await this.call("chat_model", { agentId: rt.agent_id, conversationId: rt.conversation_id, handle, reasoningEffort });
    return { handle, reasoningEffort } as AppliedModel;
  }

  async listModels(): Promise<ModelEntry[]> {
    return (await this.call("chat_models", {})).entries;
  }

  async listAgents(): Promise<Array<{ id: string; name?: string; hidden?: boolean }>> {
    return (await this.call("chat_agents", {})).agents;
  }

  async createAgent(opts: { personality: Personality; model?: string; tags?: string[] }): Promise<{ id: string; name: string; model: string | null }> {
    const created = await this.call("chat_agent_create", { name: "New agent", description: null, model: opts.model ?? null }, 30_000);
    return { id: created.id, name: created.name, model: opts.model ?? null };
  }

  async updateAgent(agentId: string, body: Record<string, unknown>): Promise<void> {
    await this.call("chat_agent_update", {
      agentId,
      ...(typeof body.name === "string" ? { name: body.name } : {}),
      ...(typeof body.description === "string" ? { description: body.description } : {}),
      ...(typeof body.model === "string" ? { model: body.model } : {}),
    } as InputOf<"chat_agent_update">);
  }

  async deleteAgent(agentId: string): Promise<void> {
    await this.call("chat_agent_delete", { agentId }, 30_000);
  }

  /** The thread comes from the mod's history (history_get) on the daemon; there is no second source. */
  async listMessages(): Promise<Array<Record<string, unknown>>> {
    return [];
  }

  // What later units bring to the daemon (plan 017): providers (U8), memory and
  // reflection (U9), skills and commands (U10).
  async respondApproval(rt: Runtime, requestId: string, behavior: "allow" | "deny"): Promise<boolean> {
    return (await this.call("chat_approve", { agentId: rt.agent_id, conversationId: rt.conversation_id, requestId, allow: behavior === "allow", message: null })).accepted;
  }

  async answerQuestion(rt: Runtime, requestId: string, updatedInput: Record<string, unknown>): Promise<boolean> {
    return (await this.call("chat_answer", { agentId: rt.agent_id, conversationId: rt.conversation_id, requestId, input: updatedInput })).accepted;
  }
  async listConnectProviders(): Promise<ConnectProvider[]> {
    return [];
  }
  async connectProvider(): Promise<ConnectProvider[]> {
    throw NOT_YET("connecting a provider");
  }
  async disconnectProvider(): Promise<ConnectProvider[]> {
    throw NOT_YET("disconnecting a provider");
  }
  async getReflectionSettings(): Promise<ReflectionSettings | null> {
    return null;
  }
  async setReflectionSettings(_rt: Runtime, _s: { trigger: ReflectionTrigger; stepCount: number; merge: ReflectionMerge; mergeInstructions?: string }): Promise<ReflectionSettings | null> {
    throw NOT_YET("reflection settings");
  }
  async writeMemoryFile(): Promise<void> {
    throw NOT_YET("editing memory");
  }
  async deleteMemoryFile(): Promise<void> {
    throw NOT_YET("editing memory");
  }
  async skillEnable(): Promise<{ name: string; linkPath: string }> {
    throw NOT_YET("enabling a skill");
  }
  async skillDisable(): Promise<void> {
    throw NOT_YET("disabling a skill");
  }
  async executeCommand(): Promise<{ success: boolean; output: string }> {
    return { success: false, output: "commands are not on loki's daemon yet" };
  }
}
