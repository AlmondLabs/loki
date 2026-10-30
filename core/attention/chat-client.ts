import type { AppliedModel, ModelEntry, ModelSelection } from "../models.ts";
import type { InputOf, ReplyOf, RequestName, RequestResult, SuggestionAction } from "../frames.ts";
import type { SuggestionTarget } from "../frame-types.ts";
import type { ImageAttachment } from "./content.ts";
import type { ChatEvent } from "./model.ts";
import type { ConnectProvider, PassSettings, PassSettingsChange, Runtime, ServerEvent } from "./protocol.ts";
import { Listeners } from "../listeners.ts";
import { messageOf } from "../errors.ts";

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
  | "labels"
  | "suggestions"
  | "disconnectProvider"
  | "executeCommand"
  | "getPassSettings"
  | "isSubscribed"
  | "listAgents"
  | "listConnectProviders"
  | "listModels"
  | "renameConversation"
  | "respondApproval"
  | "runtimeStart"
  | "sendUserMessage"
  | "setPassSettings"
  | "updateAgent"
  | "updateConversation"
  | "updateModel"
  | "close"
  | "onChat"
  | "onListsStale"
  | "serverInfo"
  | "onStatus"
>;

/** The link to the daemon as a chat client reports it. */
export type LinkStatus = "connecting" | "open" | "closed";

/** A new agent as the person describes it: its name, a line about it, who it is (its persona), and its model. */
export interface NewAgentOptions {
  name: string;
  description?: string;
  persona?: string;
  model?: string;
}

/** The mod socket's request, as the app's useDesk makes it. */
export type FrameRequest = <N extends RequestName>(type: N, payload: InputOf<N>, timeoutMs: number) => Promise<RequestResult<ReplyOf<N>>>;

/**
 * loki's daemon, through the mod's frames (core/frames.ts chat_*). A chat is named by its agent and id on the wire;
 * the attention model sometimes names it by id alone (archiving from the sidebar), so the client remembers each
 * chat's agent as it meets it, and asks `agentOf` for the rest.
 */
export class FrameChatClient {
  private readonly request: FrameRequest;
  private readonly agentOf: (conversationId: string) => string | null;
  private readonly unsubscribe: () => void;
  private readonly listeners = new Listeners<[rt: Runtime, events: ChatEvent[]]>();
  private readonly staleListeners = new Listeners();
  private readonly statuses = new Listeners<[status: LinkStatus]>();
  private readonly opened = new Set<string>();
  private readonly agents = new Map<string, string>();
  private readonly openUrl: (url: string) => void;

  /**
   * `onReconnect`: told each time the mod's socket opens again. The daemon may have restarted meanwhile and follows
   * none of the chats this client opened, and a turn may have ended unheard: each is opened again, which brings its
   * state now (a finished turn stops showing as running) and its events from here on. `onListsStale`: told when the
   * lists a client holds may be out of date (an agent changed, the socket came back, the page came back from hiding).
   */
  constructor(opts: {
    request: FrameRequest;
    onChatEvent: (fn: (p: { agent_id: string; conversation_id: string; events: ChatEvent[] }) => void) => () => void;
    onReconnect?: (fn: () => void) => () => void;
    onListsStale?: (fn: () => void) => () => void;
    agentOf?: (conversationId: string) => string | null;
    openUrl?: (url: string) => void;
  }) {
    this.request = opts.request;
    this.openUrl = opts.openUrl ?? (() => {});
    this.agentOf = opts.agentOf ?? (() => null);
    const offEvents = opts.onChatEvent(({ agent_id: agentId, conversation_id: conversationId, events }) =>
      this.emit({ agent_id: agentId, conversation_id: conversationId }, events),
    );
    const offReconnect = opts.onReconnect?.(() => void this.reopen()) ?? (() => {});
    const offStale =
      opts.onListsStale?.(() => {
        this.staleListeners.emit();
      }) ?? (() => {});
    this.unsubscribe = () => {
      offEvents();
      offReconnect();
      offStale();
    };
    // The mod's socket is this client's link: open once it is made, so whoever listens right after hears it.
    queueMicrotask(() => this.statuses.emit("open"));
  }

  private emit(rt: Runtime, events: ChatEvent[]): void {
    this.listeners.emit(rt, events);
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

  /** Told when the agent and chat lists may be out of date, so they are asked for again (useAttention). */
  onListsStale(fn: () => void): () => void {
    return this.staleListeners.add(fn);
  }

  /** Told how the link to the daemon stands; returns the way to stop. */
  onStatus(fn: (status: LinkStatus) => void): () => void {
    return this.statuses.add(fn);
  }

  onChat(fn: (rt: Runtime, events: ChatEvent[]) => void): () => void {
    return this.listeners.add(fn);
  }

  /** The daemon's commands: the palette offers these and loki's own (core/attention/commands.ts). */
  serverInfo() {
    return Promise.resolve({ version: "loki daemon", protocol: null, commands: ["compact", "clear", "remember", "reflect", "doctor"], exclusive: true });
  }

  close(): void {
    this.unsubscribe();
    this.listeners.clear();
    this.statuses.clear();
  }

  /** Open every chat this client follows again (after the socket came back). */
  private async reopen(): Promise<void> {
    const chats = [...this.opened].map((key) => key.split("\u0000"));
    this.opened.clear();
    await Promise.all(chats.map(([agentId, conversationId]) => this.runtimeStart({ agent_id: agentId, conversation_id: conversationId }).catch(() => {})));
  }

  isSubscribed(rt: Runtime): boolean {
    return this.opened.has(`${rt.agent_id}\u0000${rt.conversation_id}`);
  }

  /** Open a chat: its live events follow, and its state now arrives as events too. */
  async runtimeStart(rt: Runtime, opts: { mode?: string } = {}): Promise<ServerEvent> {
    this.remember(rt);
    const state = await this.call("chat_open", { agent_id: rt.agent_id, conversation_id: rt.conversation_id, mode: opts.mode ?? null });
    this.opened.add(`${rt.agent_id}\u0000${rt.conversation_id}`);
    this.emit(rt, [
      { kind: "loop", state: state.loop, ...(state.turn_id ? { turn_id: state.turn_id } : {}) },
      {
        kind: "device",
        ...(state.mode ? { mode: state.mode } : {}),
        ...(state.cwd ? { cwd: state.cwd } : {}),
        ...(state.engine !== undefined ? { engine: state.engine } : {}),
      },
      // Opened mid-answer: what was written before this socket listened, so the reply shows from its first word.
      ...(state.streaming?.text ? [{ kind: "streaming" as const, text: state.streaming.text, at: state.streaming.at }] : []),
      // The suggestions waiting in it (plan 049): a client opening late sees them as one that was listening does.
      ...(state.suggestions ? [{ kind: "suggestions" as const, suggestions: state.suggestions }] : []),
    ]);
    return { type: "chat_state" };
  }

  /** `home` is the Mac the chat lives on (plan 023); without it the mod picks its agent's, when in reach. */
  async createConversation(agentId: string, cwd: string, name?: string, home?: string): Promise<Runtime> {
    const created = await this.call("chat_create", { agent_id: agentId, cwd, title: name ?? null, ...(home ? { home } : {}) });
    const rt = this.remember({ agent_id: created.agent_id, conversation_id: created.conversation_id });
    await this.runtimeStart(rt);
    return rt;
  }

  /** `steer` puts the message into the chat's running turn instead of after it (loki's own engine only). */
  async sendUserMessage(rt: Runtime, text: string, images: ImageAttachment[] = [], context?: string, steer = false): Promise<boolean> {
    this.remember(rt);
    const sendId = `send-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const r = await this.call("chat_send", {
      agent_id: rt.agent_id,
      conversation_id: rt.conversation_id,
      text,
      images: images.map((i) => ({ media_type: i.mediaType, data: i.data })),
      send_id: sendId,
      context: context ?? null,
      ...(steer ? { steer: true } : {}),
    });
    return r.accepted;
  }

  async abortTurn(rt: Runtime): Promise<boolean> {
    await this.call("chat_abort", { agent_id: rt.agent_id, conversation_id: rt.conversation_id });
    return true;
  }

  async changeFolder(rt: Runtime, cwd: string): Promise<void> {
    await this.call("chat_folder", { agent_id: rt.agent_id, conversation_id: rt.conversation_id, cwd });
  }

  async updateConversation(conversationId: string, body: Record<string, unknown>): Promise<void> {
    await this.call("chat_update", {
      agent_id: this.agentFor(conversationId),
      conversation_id: conversationId,
      ...(typeof body.summary === "string" || body.summary === null ? { title: body.summary } : {}),
      ...(typeof body.archived === "boolean" ? { archived: body.archived } : {}),
      ...(typeof body.hidden === "boolean" ? { hidden: body.hidden } : {}),
      ...(typeof body.purpose === "string" || body.purpose === null ? { purpose: body.purpose } : {}),
      // The app only ever clears a saved draft (an emptied box); saving one is the suggestion's own action (plan 049, KTD7).
      ...(body.draft === null ? { draft: null } : {}),
    });
  }

  async renameConversation(conversationId: string, name: string): Promise<void> {
    await this.updateConversation(conversationId, { summary: name });
  }

  async updateModel(rt: Runtime, choice: ModelSelection | string): Promise<AppliedModel> {
    const handle = typeof choice === "string" ? choice : choice.handle;
    const reasoningEffort = typeof choice === "string" ? null : (choice.reasoning_effort ?? null);
    await this.call("chat_model", { agent_id: rt.agent_id, conversation_id: rt.conversation_id, handle, reasoning_effort: reasoningEffort });
    return { handle, reasoning_effort: reasoningEffort };
  }

  async listModels(): Promise<ModelEntry[]> {
    return (await this.call("chat_models", {})).entries;
  }

  async listAgents(): Promise<Array<{ id: string; name?: string; hidden?: boolean; home_mac?: string | null }>> {
    return (await this.call("chat_agents", {})).agents;
  }

  async createAgent(opts: NewAgentOptions): Promise<{ id: string; name: string; model: string | null }> {
    const created = await this.call(
      "chat_agent_create",
      { name: opts.name, description: opts.description ?? null, persona: opts.persona ?? null, model: opts.model ?? null },
      30_000,
    );
    return { id: created.id, name: created.name, model: opts.model ?? null };
  }

  async updateAgent(agentId: string, body: Record<string, unknown>): Promise<void> {
    await this.call("chat_agent_update", {
      agent_id: agentId,
      ...(typeof body.name === "string" ? { name: body.name } : {}),
      ...(typeof body.description === "string" ? { description: body.description } : {}),
      ...(typeof body.model === "string" ? { model: body.model } : {}),
    });
  }

  async deleteAgent(agentId: string): Promise<void> {
    await this.call("chat_agent_delete", { agent_id: agentId }, 30_000);
  }

  /** The thread comes from the mod's history (history_get) on the daemon; there is no second source. */
  /** "always" allows this call and every later one of the same tool (daemon/approvals.ts), but in strict mode. */
  async respondApproval(rt: Runtime, requestId: string, behavior: "allow" | "deny" | "always"): Promise<boolean> {
    return (
      await this.call("chat_approve", {
        agent_id: rt.agent_id,
        conversation_id: rt.conversation_id,
        approval_id: requestId,
        allow: behavior !== "deny",
        always: behavior === "always",
        message: null,
      })
    ).accepted;
  }

  async answerQuestion(rt: Runtime, requestId: string, updatedInput: Record<string, unknown>): Promise<boolean> {
    return (await this.call("chat_answer", { agent_id: rt.agent_id, conversation_id: rt.conversation_id, question_id: requestId, input: updatedInput }))
      .accepted;
  }
  async listConnectProviders(): Promise<ConnectProvider[]> {
    return (await this.call("chat_providers", {})).providers;
  }

  /**
   * An API key goes to the daemon, which keeps it once the provider accepts it. Signing in opens the provider's page
   * in the browser and waits (up to five minutes) for the daemon to report the provider connected.
   */
  async connectProvider(providerId: string, fields: Partial<Record<string, string>>, authMethodId?: string): Promise<ConnectProvider[]> {
    // The address the browser ended on, for a sign-in that is waiting: the daemon finishes it, and the wait below sees it.
    if (authMethodId === "oauth_code") {
      await this.call("chat_provider_signin", { provider_id: providerId, code: fields.redirect_url ?? "" }, 30_000);
      return this.listConnectProviders();
    }
    if (authMethodId !== "oauth")
      return (await this.call("chat_provider_connect", { provider_id: providerId, api_key: fields.api_key ?? "" }, 30_000)).providers;
    const page = await this.call("chat_provider_signin", { provider_id: providerId, code: null }, 30_000);
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
    return (await this.call("chat_provider_disconnect", { provider_id: providerId })).providers;
  }

  async getPassSettings(): Promise<PassSettings | null> {
    return this.call("chat_passes_get", {});
  }
  async setPassSettings(s: PassSettingsChange): Promise<PassSettings | null> {
    return this.call("chat_passes_set", s);
  }

  /**
   * Labels on chats (plan 022): every label with its colour and count, a chat's labels set (the whole list), and a
   * label renamed, recoloured or deleted on every chat. `get` and `edit` answer with the labels as they now stand.
   */
  readonly labels = {
    get: () => this.call("chat_labels_get", {}),
    set: async (rt: Runtime, labels: string[]): Promise<void> => {
      await this.call("chat_update", { agent_id: rt.agent_id, conversation_id: rt.conversation_id, labels });
    },
    edit: (change: InputOf<"chat_label_set">) => this.call("chat_label_set", change),
  };
  /**
   * The person's actions on a suggestion made in a chat (plan 049), carried out by the Mac that chat lives on: each
   * answers with the suggestion as it then stands, and whether the action took or why not.
   */
  readonly suggestions = {
    decide: (rt: Runtime, suggestionId: string, action: SuggestionAction) =>
      this.call("suggestion_decide", { agent_id: rt.agent_id, conversation_id: rt.conversation_id, suggestion_id: suggestionId, action }),
    retarget: (rt: Runtime, suggestionId: string, target: SuggestionTarget) =>
      this.call("suggestion_retarget", { agent_id: rt.agent_id, conversation_id: rt.conversation_id, suggestion_id: suggestionId, target }),
  };

  /** A slash command, shown in the thread as it runs and when it answers. */
  async executeCommand(rt: Runtime, commandId: string, args?: string): Promise<{ success: boolean; output: string }> {
    const input = `/${commandId}${args ? ` ${args}` : ""}`;
    this.emit(rt, [{ kind: "command", phase: "start", input }]);
    // A memory review reads all of memory and may edit a lot of it: it gets the pass's own time limit (daemon/passes.ts), and a little more.
    const r = await this.call(
      "chat_command",
      { agent_id: rt.agent_id, conversation_id: rt.conversation_id, command: commandId, args: args ?? null },
      commandId === "doctor" ? 11 * 60_000 : 180_000,
    ).catch((err: unknown) => ({ success: false, output: messageOf(err) }));
    this.emit(rt, [{ kind: "command", phase: "end", input, success: r.success, output: r.output }]);
    return r;
  }
}
