import type { AppliedModel, ModelEntry, ModelSelection } from "../models.ts";
import type { InputOf, ReplyOf, RequestName, RequestResult } from "../frames.ts";
import type { ImageAttachment } from "./content.ts";
import type { ChatEvent } from "./model.ts";
import type { ConnectProvider, Personality, ReflectionMerge, ReflectionSettings, ReflectionTrigger, Runtime, ServerEvent } from "./protocol.ts";

/**
 * What the attention model (useAttention) talks to for a chat's live half (plan 017, U5): loki's daemon, through the
 * mod's own frames (FrameChatClient below). Events arrive as loki's chat events. A test may stand in for it.
 */
export type ChatClient = Pick<
  FrameChatClient,
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
  | "onChat"
  | "serverInfo"
> & { onStatus?: (s: "connecting" | "open" | "closed") => void };

/** The mod socket's request, as the app's useDesk makes it. */
export type FrameRequest = <N extends RequestName>(type: N, payload: InputOf<N>, timeoutMs: number) => Promise<RequestResult<ReplyOf<N>>>;

/**
 * loki's daemon, through the mod's frames (core/frames.ts chat_*). A chat is named by its agent and id on the wire;
 * the attention model sometimes names it by id alone (archiving from the sidebar), so the client remembers each
 * chat's agent as it meets it, and asks `agentOf` for the rest.
 */
export class FrameChatClient {
  onStatus?: (s: "connecting" | "open" | "closed") => void;
  private readonly request: FrameRequest;
  private readonly agentOf: (conversationId: string) => string | null;
  private readonly unsubscribe: () => void;
  private readonly listeners = new Set<(rt: Runtime, events: ChatEvent[]) => void>();
  private readonly opened = new Set<string>();
  private readonly agents = new Map<string, string>();
  private readonly openUrl: (url: string) => void;

  constructor(opts: { request: FrameRequest; onChatEvent: (fn: (p: { agentId: string; conversationId: string; events: ChatEvent[] }) => void) => () => void; agentOf?: (conversationId: string) => string | null; openUrl?: (url: string) => void }) {
    this.request = opts.request;
    this.openUrl = opts.openUrl ?? (() => {});
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

  /** The daemon's commands: the palette offers these and loki's own (core/attention/commands.ts). */
  async serverInfo() {
    return { version: "loki daemon", protocol: null, commands: ["compact", "clear", "remember", "reflect"], exclusive: true };
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
  async respondApproval(rt: Runtime, requestId: string, behavior: "allow" | "deny"): Promise<boolean> {
    return (await this.call("chat_approve", { agentId: rt.agent_id, conversationId: rt.conversation_id, approvalId: requestId, allow: behavior === "allow", message: null })).accepted;
  }

  async answerQuestion(rt: Runtime, requestId: string, updatedInput: Record<string, unknown>): Promise<boolean> {
    return (await this.call("chat_answer", { agentId: rt.agent_id, conversationId: rt.conversation_id, questionId: requestId, input: updatedInput })).accepted;
  }
  async listConnectProviders(): Promise<ConnectProvider[]> {
    return (await this.call("chat_providers", {})).providers;
  }

  /**
   * An API key goes to the daemon, which keeps it once the provider accepts it. Signing in opens the provider's page
   * in the browser and waits (up to five minutes) for the daemon to report the provider connected.
   */
  async connectProvider(providerId: string, fields: Record<string, string>, authMethodId?: string): Promise<ConnectProvider[]> {
    // The address the browser ended on, for a sign-in that is waiting: the daemon finishes it, and the wait below sees it.
    if (authMethodId === "oauth_code") {
      await this.call("chat_provider_signin", { providerId, code: fields.redirect_url ?? "" }, 30_000);
      return this.listConnectProviders();
    }
    if (authMethodId !== "oauth") return (await this.call("chat_provider_connect", { providerId, apiKey: fields.api_key ?? "" }, 30_000)).providers;
    const page = await this.call("chat_provider_signin", { providerId, code: null }, 30_000);
    this.openUrl(page.url);
    const until = Date.now() + 5 * 60_000;
    while (Date.now() < until) {
      await new Promise((r) => setTimeout(r, 2000));
      const list = await this.listConnectProviders();
      if (list.find((p) => p.id === providerId)?.connected.is_connected) return list;
    }
    throw new Error(page.instructions ? `sign-in did not finish: ${page.instructions}` : "sign-in did not finish");
  }

  async disconnectProvider(providerId: string): Promise<ConnectProvider[]> {
    return (await this.call("chat_provider_disconnect", { providerId })).providers;
  }
  async getReflectionSettings(): Promise<ReflectionSettings | null> {
    return this.call("chat_reflection_get", {});
  }
  async setReflectionSettings(_rt: Runtime, s: { trigger: ReflectionTrigger; stepCount: number; merge: ReflectionMerge; mergeInstructions?: string }): Promise<ReflectionSettings | null> {
    return this.call("chat_reflection_set", { trigger: s.trigger, stepCount: s.stepCount, merge: s.merge, mergeInstructions: s.mergeInstructions ?? "" });
  }
  async writeMemoryFile(agentId: string, path: string, content: string, commitMessage?: string): Promise<void> {
    await this.call("chat_memory_write", { agentId, path, content, message: commitMessage });
  }
  async deleteMemoryFile(agentId: string, path: string, commitMessage?: string): Promise<void> {
    await this.call("chat_memory_write", { agentId, path, content: null, message: commitMessage });
  }
  async skillEnable(skillPath: string): Promise<{ name: string; linkPath: string }> {
    return this.call("chat_skill_enable", { path: skillPath });
  }
  async skillDisable(name: string): Promise<void> {
    await this.call("chat_skill_disable", { name });
  }

  /** A slash command, shown in the thread as it runs and when it answers, as Letta's were. */
  async executeCommand(rt: Runtime, commandId: string, args?: string): Promise<{ success: boolean; output: string }> {
    const input = `/${commandId}${args ? ` ${args}` : ""}`;
    this.emit(rt, [{ kind: "command", phase: "start", input }]);
    const r = await this.call("chat_command", { agentId: rt.agent_id, conversationId: rt.conversation_id, command: commandId, args: args ?? null }, 180_000).catch((err: unknown) => ({ success: false, output: err instanceof Error ? err.message : String(err) }));
    this.emit(rt, [{ kind: "command", phase: "end", input, success: r.success, output: r.output }]);
    return r;
  }
}
