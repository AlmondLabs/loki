import { isReasoningEffort, type AppliedModel, type ModelEntry, type ModelSelection } from "../models.ts";
import { DOCTOR_WAIT_MS, HANDOFF_WAIT_MS, REPLY_WAIT_MS } from "../frame-client.ts";
import type { InputOf, ReplyAction, ReplyDecideOptions, ReplyOf, RequestName, RequestResult, SuggestionAction } from "../frames.ts";
import type {
  AccountLabel,
  HandoffProposal,
  EmojiChoice,
  SlackPerson,
  MailAddressing,
  MailCompose,
  OutsideChange,
  OutsideMove,
  OutsideRead,
  OutsideReplied,
  OutsideWindowAsk,
  ReplyMention,
  ReplyThen,
  SuggestionTarget,
} from "../frame-types.ts";
import type { LinkDuration } from "../chat-links.ts";
import type { ImageAttachment } from "./content.ts";
import type { ChatEvent } from "./model.ts";
import type { ConnectProvider, PassSettings, PassSettingsChange, Runtime, ServerEvent } from "./protocol.ts";
import { Listeners } from "../listeners.ts";
import { messageOf } from "../errors.ts";

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
  | "replies"
  | "links"
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
  | "archiveOutside"
  | "markReadOutside"
  | "markUnreadOutside"
  | "labelOutside"
  | "restoreOutside"
  | "labelsOutside"
  | "handoffPropose"
  | "readOutside"
  | "replyOutside"
  | "composeOutside"
  | "unsendOutside"
  | "keepMoveHere"
  | "resendOutside"
  | "discardOutside"
  | "reactOutside"
  | "searchEmoji"
  | "searchPeople"
  | "moveOutside"
  | "handoff"
  | "updateModel"
  | "close"
  | "onChat"
  | "onListsStale"
  | "serverInfo"
  | "onStatus"
  | "onReopened"
>;

export type LinkStatus = "connecting" | "open" | "closed";

export interface NewAgentOptions {
  name: string;
  description?: string;
  persona?: string;
  model?: string;
}

export type FrameRequest = <N extends RequestName>(type: N, payload: InputOf<N>, timeoutMs: number) => Promise<RequestResult<ReplyOf<N>>>;

export class FrameChatClient {
  private readonly request: FrameRequest;
  private readonly agentOf: (conversationId: string) => string | null;
  private readonly unsubscribe: () => void;
  private readonly listeners = new Listeners<[rt: Runtime, events: ChatEvent[]]>();
  private readonly staleListeners = new Listeners();
  private readonly reopened = new Listeners();
  private readonly statuses = new Listeners<[status: LinkStatus]>();
  private readonly opened = new Set<string>();
  private readonly agents = new Map<string, string>();
  private readonly openUrl: (url: string) => void;

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

  onListsStale(fn: () => void): () => void {
    return this.staleListeners.add(fn);
  }

  onStatus(fn: (status: LinkStatus) => void): () => void {
    return this.statuses.add(fn);
  }

  onReopened(fn: () => void): () => void {
    return this.reopened.add(fn);
  }

  onChat(fn: (rt: Runtime, events: ChatEvent[]) => void): () => void {
    return this.listeners.add(fn);
  }

  serverInfo() {
    return Promise.resolve({
      version: "loki daemon",
      protocol: null,
      commands: ["compact", "clear", "remember", "reflect", "doctor", "advisor"],
      exclusive: true,
    });
  }

  close(): void {
    this.unsubscribe();
    this.listeners.clear();
    this.statuses.clear();
  }

  private async reopen(): Promise<void> {
    const chats = [...this.opened].map((key) => key.split("\u0000"));
    this.opened.clear();
    await Promise.all(chats.map(([agentId, conversationId]) => this.runtimeStart({ agent_id: agentId, conversation_id: conversationId }).catch(() => {})));
    this.reopened.emit();
  }

  isSubscribed(rt: Runtime): boolean {
    return this.opened.has(`${rt.agent_id}\u0000${rt.conversation_id}`);
  }

  async runtimeStart(rt: Runtime, opts: { mode?: string } = {}): Promise<ServerEvent> {
    this.remember(rt);
    const state = await this.call("chat_open", { agent_id: rt.agent_id, conversation_id: rt.conversation_id, mode: opts.mode ?? null });
    this.opened.add(`${rt.agent_id}\u0000${rt.conversation_id}`);
    this.emit(rt, [
      { kind: "loop", state: state.loop },
      {
        kind: "device",
        ...(state.mode ? { mode: state.mode } : {}),
        ...(state.cwd ? { cwd: state.cwd } : {}),
        ...(state.engine !== undefined ? { engine: state.engine } : {}),
      },
      ...(state.streaming?.text ? [{ kind: "streaming" as const, text: state.streaming.text, at: state.streaming.at }] : []),
      ...(state.suggestions ? [{ kind: "suggestions" as const, suggestions: state.suggestions }] : []),
      ...(state.reply_proposals ? [{ kind: "reply_proposals" as const, proposals: state.reply_proposals }] : []),
      ...(state.links ? [{ kind: "links" as const, links: state.links }] : []),
      ...(state.advisor !== undefined ? [{ kind: "advisor" as const, advisor: state.advisor }] : []),
    ]);
    return { type: "chat_state" };
  }

  async createConversation(agentId: string, cwd: string, name?: string, home?: string): Promise<Runtime> {
    const created = await this.call("chat_create", { agent_id: agentId, cwd, title: name ?? null, ...(home ? { home } : {}) });
    const rt = this.remember({ agent_id: created.agent_id, conversation_id: created.conversation_id });
    await this.runtimeStart(rt);
    return rt;
  }

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

  async keepMoveHere(rt: Runtime): Promise<void> {
    await this.call("chat_move_keep", { agent_id: rt.agent_id, conversation_id: rt.conversation_id });
  }

  async abortTurn(rt: Runtime): Promise<boolean> {
    await this.call("chat_abort", { agent_id: rt.agent_id, conversation_id: rt.conversation_id });
    return true;
  }

  async changeFolder(rt: Runtime, cwd: string): Promise<void> {
    await this.call("chat_folder", { agent_id: rt.agent_id, conversation_id: rt.conversation_id, cwd });
  }

  async archiveOutside(accountId: string, threadId: string, home: string | null): Promise<OutsideChange | null> {
    const r = await this.call("account_thread_archive", { account_id: accountId, thread_id: threadId, home });
    return r.change;
  }

  async markReadOutside(accountId: string, threadId: string, home: string | null): Promise<OutsideChange | null> {
    const r = await this.call("account_thread_mark_read", { account_id: accountId, thread_id: threadId, home });
    return r.change;
  }

  async markUnreadOutside(accountId: string, threadId: string, home: string | null): Promise<OutsideChange | null> {
    const r = await this.call("account_thread_mark_unread", { account_id: accountId, thread_id: threadId, home });
    return r.change;
  }

  async labelOutside(accountId: string, threadId: string, labels: string[], home: string | null): Promise<OutsideChange | null> {
    const r = await this.call("account_thread_label", { account_id: accountId, thread_id: threadId, labels, home });
    return r.change;
  }

  async restoreOutside(accountId: string, threadId: string, change: OutsideChange, home: string | null): Promise<void> {
    await this.call("account_thread_restore", { account_id: accountId, thread_id: threadId, change, home });
  }

  async labelsOutside(accountId: string, home: string | null): Promise<AccountLabel[]> {
    const r = await this.call("account_labels_list", { account_id: accountId, home });
    return r.labels;
  }

  async readOutside(accountId: string, threadId: string, home: string | null, ask: OutsideWindowAsk = {}): Promise<OutsideRead> {
    const r = await this.call("account_thread_read", { account_id: accountId, thread_id: threadId, home, ...ask }, 30_000);
    return { messages: r.messages, window: r.window ?? null, ...(r.link ? { link: r.link } : {}), ...(r.ticket ? { ticket: r.ticket } : {}) };
  }

  async replyOutside(
    accountId: string,
    threadId: string,
    text: string,
    then: ReplyThen,
    home: string | null,
    extra: { mail?: MailAddressing | null; outbox_id?: string | null; thread_ts?: string | null; mentions?: readonly ReplyMention[] } = {},
  ): Promise<OutsideReplied> {
    const r = await this.call(
      "account_thread_reply",
      {
        account_id: accountId,
        thread_id: threadId,
        text,
        then,
        home,
        ...(extra.mail ? { mail: extra.mail } : {}),
        ...(extra.outbox_id ? { outbox_id: extra.outbox_id } : {}),
        ...(extra.thread_ts ? { thread_ts: extra.thread_ts } : {}),
        mentions: [...(extra.mentions ?? [])],
      },
      REPLY_WAIT_MS,
    );
    return r.sent ? { sent: true, then_error: r.then_error, change: r.change } : { sent: false, undone: true };
  }

  async composeOutside(accountId: string, threadId: string, home: string | null): Promise<MailCompose> {
    const r = await this.call("account_thread_compose", { account_id: accountId, thread_id: threadId, home }, 30_000);
    return { modes: r.modes, from: r.from, default_from: r.default_from, subject: r.subject, people: r.people };
  }

  async reactOutside(accountId: string, threadId: string, messageId: string, name: string, on: boolean, home: string | null): Promise<void> {
    await this.call("account_thread_react", { account_id: accountId, thread_id: threadId, message_id: messageId, name, on, home }, 30_000);
  }

  async searchEmoji(accountId: string, query: string, home: string | null): Promise<EmojiChoice[]> {
    const r = await this.call("account_emoji_search", { account_id: accountId, query, home });
    return r.emoji;
  }

  async searchPeople(accountId: string, query: string, home: string | null): Promise<SlackPerson[]> {
    const r = await this.call("account_people_search", { account_id: accountId, query, home });
    return r.people;
  }

  async unsendOutside(accountId: string, outboxId: string, home: string | null): Promise<boolean> {
    const r = await this.call("account_thread_unsend", { account_id: accountId, outbox_id: outboxId, home });
    return r.undone;
  }

  async resendOutside(accountId: string, threadId: string, outboxId: string, home: string | null): Promise<OutsideReplied> {
    const r = await this.call("account_thread_resend", { account_id: accountId, thread_id: threadId, outbox_id: outboxId, home }, REPLY_WAIT_MS);
    return r.sent ? { sent: true, then_error: r.then_error, change: r.change } : { sent: false, undone: true };
  }

  async discardOutside(accountId: string, outboxId: string, home: string | null): Promise<boolean> {
    const r = await this.call("account_thread_discard", { account_id: accountId, outbox_id: outboxId, home });
    return r.discarded;
  }

  async moveOutside(accountId: string, threadId: string, move: OutsideMove, home: string | null): Promise<void> {
    await this.call("account_thread_move", { account_id: accountId, thread_id: threadId, ...move, home });
  }

  async handoffPropose(accountId: string, threadId: string, home: string | null): Promise<HandoffProposal> {
    const r = await this.call("account_thread_handoff_propose", { account_id: accountId, thread_id: threadId, home });
    return { account_id: r.account_id, thread_id: r.thread_id, owner_agent_id: r.owner_agent_id, proposed: r.proposed, choices: r.choices, note: r.note };
  }

  async handoff(
    accountId: string,
    threadId: string,
    conversationId: string | null,
    home: string | null,
  ): Promise<{ agent_id: string; conversation_id: string }> {
    const r = await this.call("account_thread_handoff", { account_id: accountId, thread_id: threadId, conversation_id: conversationId, home }, HANDOFF_WAIT_MS);
    return { agent_id: r.agent_id, conversation_id: r.conversation_id };
  }

  async updateConversation(conversationId: string, body: Record<string, unknown>, agentId?: string): Promise<void> {
    await this.call("chat_update", {
      agent_id: agentId ?? this.agentFor(conversationId),
      conversation_id: conversationId,
      ...(typeof body.summary === "string" || body.summary === null ? { title: body.summary } : {}),
      ...(typeof body.archived === "boolean" ? { archived: body.archived } : {}),
      ...(typeof body.hidden === "boolean" ? { hidden: body.hidden } : {}),
      ...(typeof body.purpose === "string" || body.purpose === null ? { purpose: body.purpose } : {}),
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
      ...(typeof body.advisor_model === "string" || body.advisor_model === null ? { advisor_model: body.advisor_model } : {}),
      ...(isReasoningEffort(body.advisor_reasoning_effort) || body.advisor_reasoning_effort === null
        ? { advisor_reasoning_effort: body.advisor_reasoning_effort }
        : {}),
    });
  }

  async deleteAgent(agentId: string): Promise<void> {
    await this.call("chat_agent_delete", { agent_id: agentId }, 30_000);
  }

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

  async connectProvider(providerId: string, fields: Partial<Record<string, string>>, authMethodId?: string): Promise<ConnectProvider[]> {
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

  readonly labels = {
    get: () => this.call("chat_labels_get", {}),
    set: async (rt: Runtime, labels: string[]): Promise<void> => {
      await this.call("chat_update", { agent_id: rt.agent_id, conversation_id: rt.conversation_id, labels });
    },
    edit: (change: InputOf<"chat_label_set">) => this.call("chat_label_set", change),
  };
  readonly suggestions = {
    decide: (rt: Runtime, suggestionId: string, action: SuggestionAction) =>
      this.call("suggestion_decide", { agent_id: rt.agent_id, conversation_id: rt.conversation_id, suggestion_id: suggestionId, action }),
    retarget: (rt: Runtime, suggestionId: string, target: SuggestionTarget) =>
      this.call("suggestion_retarget", { agent_id: rt.agent_id, conversation_id: rt.conversation_id, suggestion_id: suggestionId, target }),
  };

  readonly replies = {
    decide: (rt: Runtime, proposalId: string, action: ReplyAction, opts: ReplyDecideOptions = {}) =>
      this.call("reply_decide", {
        agent_id: rt.agent_id,
        conversation_id: rt.conversation_id,
        proposal_id: proposalId,
        action,
        ...(opts.text != null ? { text: opts.text } : {}),
        ...(opts.files ? { files: [...opts.files] } : {}),
        ...(opts.mentions?.length ? { mentions: [...opts.mentions] } : {}),
        ...(opts.title ? { title: opts.title } : {}),
      }),
    findPeople: (rt: Runtime, proposalId: string, query: string) =>
      this.call("reply_people_find", { agent_id: rt.agent_id, conversation_id: rt.conversation_id, proposal_id: proposalId, query }),
  };

  readonly links = {
    list: () => this.call("chat_links_get", {}),
    close: (rt: Runtime, linkId: string) => this.call("chat_link_close", { agent_id: rt.agent_id, conversation_id: rt.conversation_id, link_id: linkId }),
    setDefault: (duration: LinkDuration) => this.call("chat_links_default", { duration }),
  };

  async executeCommand(rt: Runtime, commandId: string, args?: string): Promise<{ success: boolean; output: string }> {
    const input = `/${commandId}${args ? ` ${args}` : ""}`;
    this.emit(rt, [{ kind: "command", phase: "start", input }]);
    const r = await this.call(
      "chat_command",
      { agent_id: rt.agent_id, conversation_id: rt.conversation_id, command: commandId, args: args ?? null },
      commandId === "doctor" ? DOCTOR_WAIT_MS : 180_000,
    ).catch((err: unknown) => ({ success: false, output: messageOf(err) }));
    this.emit(rt, [{ kind: "command", phase: "end", input, success: r.success, output: r.output }]);
    return r;
  }
}
