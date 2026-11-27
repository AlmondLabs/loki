import type { ChatLink, LinkDuration } from "../chat-links.ts";
import type { AppliedModel, ModelSelection } from "../models.ts";
import { isMainChat } from "../canvas-core.ts";
import { keepSame } from "../same-data.ts";
import type { ChatClient, NewAgentOptions } from "./chat-client.ts";
import { buildQuestionAnswer, environmentNote, type Attachment, type EnvNoteTold } from "./content.ts";
import {
  applyChatEvent,
  cancelQueued as dropQueued,
  emptyLive,
  faceOf,
  folderMoveAnswer,
  keyOf,
  sendMode,
  takeQueued,
  type ConversationInfo,
  type Live,
} from "./model.ts";
import type { ConnectProvider, PassSettings, PassSettingsChange, Runtime } from "./protocol.ts";
import type { ReplyAction, ReplyDecideOptions, SuggestionAction } from "../frames.ts";
import type { ReplyPersonChoice, Suggestion, SuggestionTarget } from "../frame-types.ts";
import { commandInput } from "./commands.ts";
import { RELOADED, type HistoryRow } from "./thread.ts";
import type { TranscriptRow } from "./transcript.ts";
import { coalesce } from "../timers.ts";
import { Listeners } from "../listeners.ts";
import { messageOf } from "../errors.ts";
import { createSentReplies } from "./sent-replies.ts";
import { PickedPeople } from "./picked-people.ts";
import {
  FOLDER_MOVE_MS,
  HISTORY_PAGE,
  LIST_RETRY_MS,
  NOT_CONNECTED,
  emptySnapshot,
  flagged,
  formatAnswerSummary,
  outgoing,
  pruneConversationKeys,
  pruneUnknownKeys,
  sentRow,
  subscribeTopConversations,
} from "./chat-store-helpers.ts";
import { createOutsideActions } from "./chat-store-outside.ts";
import type {
  AgentEntry,
  ArchiveOrigin,
  ChatSnapshot,
  ChatStoreHost,
  FolderMove,
  HistoryPage,
  OutsideCardRef,
  OutsideWritten,
  ReplyOutcome,
  SendOrigin,
  SuggestionOutcome,
} from "./chat-store-types.ts";

export {
  HISTORY_PAGE,
  type AgentEntry,
  type ArchiveOrigin,
  type ChatSnapshot,
  type ChatStoreHost,
  type HistoryPage,
  type OutsideCardRef,
  type OutsideWritten,
  type ReplyOutcome,
  type SendOrigin,
  type SuggestionOutcome,
};

export class ChatStore {
  private snap: ChatSnapshot = emptySnapshot();
  private readonly listeners = new Listeners();
  private readonly allThreadWatchers = new Listeners();
  private readonly threadWatchers = new Map<string, Listeners>();
  private readonly dirtyKeys = new Set<string>();
  private readonly liveMap = new Map<string, Live>();
  private readonly threadsRead = new Map<string, Runtime>();
  private readonly faces = new Map<string, readonly unknown[]>();
  private client: ChatClient | null = null;
  private readonly flushing = coalesce(() => this.publish(), 40);
  private readonly loading = new Set<string>();
  private readonly envNotes = new Map<string, EnvNoteTold>();
  private readonly folderMoves = new Map<string, FolderMove>();
  private known = new Set<string>();
  private lastReload = 0;
  private droppedHere = false;
  private linkDropped = false;
  private visible = true;
  private reloadNow: (() => void) | null = null;

  private current: ChatStoreHost;
  private readonly now: () => number;
  readonly sent = createSentReplies();
  readonly picked = new PickedPeople();

  private readonly outsideActions = createOutsideActions({
    sent: this.sent,
    picked: this.picked,
    now: () => this.now(),
    attempt: (work) => this.attempt(work),
    tried: (work) => this.tried(work),
    reload: () => this.reload(),
    dropCard: (card) => this.dropCard(card),
    dropCardImmediately: (card) => {
      this.set({ conversations: this.snap.conversations.filter((x) => !(x.agent_id === card.agent_id && x.id === card.id)) });
    },
  });

  constructor(host: ChatStoreHost, now: () => number = Date.now) {
    this.current = host;
    this.now = now;
  }

  setHost(host: ChatStoreHost): void {
    this.current = host;
  }

  private host(): ChatStoreHost {
    return this.current;
  }

  subscribe = (listener: () => void): (() => void) => this.listeners.add(listener);

  getSnapshot = (): ChatSnapshot => this.snap;

  watchThreads = (onChange: () => void): (() => void) => this.allThreadWatchers.add(onChange);

  watchThread = (agentId: string, conversationId: string, onChange: () => void): (() => void) => {
    const key = keyOf(agentId, conversationId);
    let list = this.threadWatchers.get(key);
    if (!list) {
      list = new Listeners();
      this.threadWatchers.set(key, list);
    }
    const off = list.add(onChange);
    return () => {
      off();
      if (this.threadWatchers.get(key)?.size === 0) this.threadWatchers.delete(key);
    };
  };

  threadRows = (agentId: string, conversationId: string): TranscriptRow[] | undefined => this.liveMap.get(keyOf(agentId, conversationId))?.thread.rows();

  setVisible(shown: boolean): void {
    this.visible = shown;
  }

  reload = (): void => this.reloadNow?.();

  connect(client: ChatClient): () => void {
    this.client = client;
    const offStatus = client.onStatus((s) => {
      this.set({ status: s });
      if (s === "closed") this.linkDropped = true;
      else if (s === "open") {
        void this.loadLabels();
        if (!this.linkDropped) return;
        this.linkDropped = false;
        let changed = false;
        for (const [k, l] of this.liveMap)
          if (l.thread.settleCommands()) {
            this.dirtyKeys.add(k);
            changed = true;
          }
        if (changed) this.bump();
      }
    });
    let reloadTimer: ReturnType<typeof setTimeout> | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let loadInFlight = false;
    let loadPending = false;
    const off = client.onChat((rt, events) => {
      const changed = this.heard(client, rt, events);
      const key = keyOf(rt.agent_id, rt.conversation_id);
      if (changed && !this.known.has(key) && !reloadTimer && this.now() - this.lastReload > 10_000) {
        reloadTimer = setTimeout(() => {
          reloadTimer = null;
          this.reload();
        }, 1500);
      }
    });
    let cancelled = false;
    let lastRows: unknown = null;
    const stopped = () => cancelled;
    const loadOnce = async () => {
      if (loadInFlight) {
        loadPending = true;
        return;
      }
      loadInFlight = true;
      try {
        void client
          .serverInfo()
          .then((info) => {
            if (!cancelled)
              this.set({ server: keepSame(this.snap.server, { version: info.version, protocol: info.protocol, advertised: [], only: info.commands }) });
          })
          .catch(() => {});
        const [agents, rows] = await Promise.all([client.listAgents(), this.host().listConversations()]);
        if (cancelled) return;
        const next: AgentEntry[] = agents.filter((a) => a.hidden !== true).map((a) => ({ id: a.id, name: a.name ?? "agent", home_mac: a.home_mac ?? null }));
        this.set({ agents: keepSame(this.snap.agents, next), agentsLoaded: true });
        if (stopped()) return;
        if (rows === null) {
          retryTimer ??= setTimeout(() => {
            retryTimer = null;
            load();
          }, LIST_RETRY_MS);
          return;
        }
        this.lastReload = this.now();
        const same = !this.droppedHere && keepSame(lastRows, rows) === lastRows;
        this.droppedHere = false;
        lastRows = rows;
        const convs: ConversationInfo[] = rows
          .map(({ last_role: _r, last_assistant_text: _t, last_ask: _a, ...c }) => c)
          .sort((a, b) => (b.last_message_at ?? "").localeCompare(a.last_message_at ?? ""));
        if (!same) {
          this.known = new Set(convs.map((c) => keyOf(c.agent_id, c.id)));
          pruneUnknownKeys(this.known, [this.liveMap, this.faces, this.envNotes, this.threadsRead]);
          this.set({
            conversations: convs,
            digests: new Map(
              rows.map((r) => [keyOf(r.agent_id, r.id), { last_role: r.last_role, last_assistant_text: r.last_assistant_text, last_ask: r.last_ask }]),
            ),
          });
        }
        this.set({ listed: true });
        await subscribeTopConversations(client, convs, this.host().subscribeLimit ?? 30, stopped);
      } finally {
        loadInFlight = false;
        if (loadPending && !cancelled) {
          loadPending = false;
          load();
        }
      }
    };
    const load = () => void loadOnce().catch((err: unknown) => console.warn("loki catch up:", err));
    this.reloadNow = load;
    load();
    const poll = setInterval(() => {
      if (this.visible) load();
    }, 60_000);
    const offStale = client.onListsStale(load);
    const offReopened = client.onReopened(() => {
      for (const rt of this.threadsRead.values()) void this.loadThread(rt);
    });
    return () => {
      cancelled = true;
      clearInterval(poll);
      offStale();
      offReopened();
      offStatus();
      if (reloadTimer) clearTimeout(reloadTimer);
      if (retryTimer) clearTimeout(retryTimer);
      off();
      this.flushing.cancel();
      for (const m of [...this.folderMoves.values()]) m.done(NOT_CONNECTED);
      this.folderMoves.clear();
      client.close();
      if (this.client === client) {
        this.client = null;
        this.reloadNow = null;
      }
      this.set({ status: "off" });
    };
  }

  dispose(): void {
    this.flushing.cancel();
  }

  private heard(client: ChatClient, rt: Runtime, events: Array<Parameters<typeof applyChatEvent>[1]>): boolean {
    const { conversation_id: conv, agent_id: agent } = rt;
    const key = keyOf(agent, conv);
    const l = this.liveOf(key);
    const wasInTurn = l.inTurn;
    const errorBefore = l.error;
    let changed = false;
    let userSpoke = false;
    for (const e of events) {
      const r = applyChatEvent(l, e);
      changed ||= r.changed;
      userSpoke ||= r.userSpoke;
    }
    const move = this.folderMoves.get(key);
    const answer = move ? folderMoveAnswer(events, l.cwd, move) : null;
    if (move && answer === "moved") move.done(null);
    else if (move && answer && answer !== "moved") {
      move.done(answer.error);
      l.error = errorBefore;
    }
    const host = this.host();
    if (userSpoke) host.markSeen(agent, conv);
    if (changed) this.bump(key);
    if (wasInTurn && !l.inTurn) {
      const next = takeQueued(l);
      if (next) {
        const out = outgoing(next.text, next.images);
        l.thread.expectEcho(out.key);
        l.inTurn = true;
        this.bump(key);
        void client
          .sendUserMessage(rt, out.text, out.images, this.noteFor(key, next.desk, next.labels))
          .catch((err: unknown) => console.warn("loki: queued send", err));
      }
    }
    return changed;
  }

  prefetchThread = (rt: Runtime): Promise<void> => {
    const key = keyOf(rt.agent_id, rt.conversation_id);
    if (this.threadsRead.has(key) || this.loading.has(key)) return Promise.resolve();
    return this.loadThread(rt);
  };

  loadThread = async (rt: Runtime): Promise<void> => {
    const key = keyOf(rt.agent_id, rt.conversation_id);
    if (this.loading.has(key)) return;
    this.loading.add(key);
    const read = async () => {
      const thread = this.liveOf(key).thread;
      const page = await this.host().loadLocalHistory?.(rt.agent_id, rt.conversation_id, HISTORY_PAGE);
      const unreached = page === null;
      this.set({ failed: flagged(this.snap.failed, key, unreached && thread.rows() === undefined) });
      if (unreached) return;
      const rows: HistoryRow[] = page?.rows ?? [];
      thread.load(rows, page?.start ?? 0);
      this.threadsRead.set(key, rt);
      const first = thread.firstPosition;
      this.set({ older: flagged(this.snap.older, key, first === null ? !!page?.more : first > 0) });
      this.dirtyKeys.add(key);
      this.publish();
    };
    await read().catch((err: unknown) => console.warn("loki: thread", err));
    this.loading.delete(key);
  };

  loadOlder = (rt: Runtime): void => {
    const key = keyOf(rt.agent_id, rt.conversation_id);
    if (this.loading.has(key)) return;
    const thread = this.liveOf(key).thread;
    const before = thread.firstPosition;
    if (before === null) return;
    this.loading.add(key);
    const read = async () => {
      const page = await this.host().loadLocalHistory?.(rt.agent_id, rt.conversation_id, HISTORY_PAGE, before);
      if (page) thread.prepend(page.rows, page.start);
      const first = thread.firstPosition;
      this.set({ older: flagged(this.snap.older, key, first !== null && first > 0) });
      this.dirtyKeys.add(key);
      this.publish();
    };
    void read()
      .catch((err: unknown) => console.warn("loki: older thread", err))
      .then(() => this.loading.delete(key));
  };

  createDesk = async (agentId: string, cwd: string, name?: string, home?: string): Promise<Runtime> => {
    const client = this.client;
    if (!client) throw new Error(NOT_CONNECTED);
    const rt = await client.createConversation(agentId, cwd, name, home);
    const agentName = this.snap.agents.find((a) => a.id === agentId)?.name ?? null;
    const made: ConversationInfo = {
      id: rt.conversation_id,
      agent_id: rt.agent_id,
      agent_name: agentName,
      title: name?.trim() || null,
      last_message_at: new Date(this.now()).toISOString(),
      archived: false,
    };
    this.set({ conversations: [made, ...this.snap.conversations] });
    return rt;
  };

  follow = async (rt: Runtime): Promise<void> => {
    const client = this.client;
    if (!client || client.isSubscribed(rt)) return;
    await client.runtimeStart(rt).catch((err: unknown) => console.warn("loki: subscribe", err));
  };

  decide = (rt: Runtime, requestId: string, behavior: "allow" | "deny" | "always"): void => {
    const key = keyOf(rt.agent_id, rt.conversation_id);
    const l = this.liveMap.get(key);
    const was = l?.pending?.requestId === requestId ? l.pending : null;
    if (l && was) l.pending = null;
    const host = this.host();
    host.markSeen(rt.agent_id, rt.conversation_id);
    host.engage?.(rt.agent_id, rt.conversation_id, "decide");
    this.bump(key);
    void this.client
      ?.respondApproval(rt, requestId, behavior)
      .catch(() => false)
      .then((ok) => {
        if (ok || !l || !was) return;
        l.pending ??= was;
        this.bump(key);
      });
  };

  answer = (rt: Runtime, requestId: string, answers: Record<string, string | string[]>): void => {
    const key = keyOf(rt.agent_id, rt.conversation_id);
    const l = this.liveMap.get(key);
    const was = l?.pendingAsk?.requestId === requestId ? l.pendingAsk : null;
    if (!l || !was) return;
    l.pendingAsk = null;
    const summary = formatAnswerSummary(was.input, answers);
    if (summary.trim()) l.thread.own({ role: "user", text: summary, at: new Date(this.now()).toISOString() });
    const host = this.host();
    host.markSeen(rt.agent_id, rt.conversation_id);
    host.engage?.(rt.agent_id, rt.conversation_id, "answer");
    this.bump(key);
    void this.client
      ?.answerQuestion(rt, requestId, buildQuestionAnswer(was.input, answers))
      .catch(() => false)
      .then((ok) => {
        if (ok) return;
        l.pendingAsk ??= was;
        this.bump(key);
      });
  };

  send = (
    rt: Runtime,
    text: string,
    images: Attachment[] = [],
    env: { desk?: string | null; labels?: readonly string[] | null; origin?: SendOrigin } = {},
  ): void => {
    const key = keyOf(rt.agent_id, rt.conversation_id);
    const l = this.liveOf(key);
    this.host().sent?.(rt);
    const at = new Date(this.now()).toISOString();
    const mode = sendMode(l);
    if (mode === "queue") {
      l.queued.push({ text, images, desk: env.desk, labels: env.labels });
      l.thread.queue(sentRow(text, images, at));
      this.bump(key);
      return;
    }
    const out = outgoing(text, images);
    l.thread.own(sentRow(text, images, at), out.key);
    l.lastRole = "user";
    this.bump(key);
    void this.follow(rt)
      .then(() => this.client?.sendUserMessage(rt, out.text, out.images, this.noteFor(key, env.desk, env.labels), mode === "steer"))
      .then(
        (accepted) => (accepted === false ? "the daemon did not take it" : null),
        (err: unknown) => messageOf(err),
      )
      .then((why) => {
        if (why === null) return;
        console.warn("loki: send", why);
        l.error = `this message may not have been sent: ${why}`;
        this.bump(key);
      });
    this.host().markSeen(rt.agent_id, rt.conversation_id);
  };

  decideSuggestion = (rt: Runtime, suggestionId: string, action: SuggestionAction): Promise<SuggestionOutcome> =>
    this.outcome((c) => c.suggestions.decide(rt, suggestionId, action));

  retargetSuggestion = (rt: Runtime, suggestionId: string, target: SuggestionTarget): Promise<SuggestionOutcome> =>
    this.outcome((c) => c.suggestions.retarget(rt, suggestionId, target));

  decideReply = async (rt: Runtime, proposalId: string, action: ReplyAction, opts: ReplyDecideOptions = {}): Promise<ReplyOutcome> => {
    const out = await this.attempt((c) => c.replies.decide(rt, proposalId, action, opts));
    return typeof out === "string" ? { done: false, message: out, proposal: null } : out;
  };
  findReplyPeople = (rt: Runtime, proposalId: string, query: string): Promise<{ people: ReplyPersonChoice[]; notice: string | null } | string> =>
    this.attempt((c) => c.replies.findPeople(rt, proposalId, query));

  closeLink = (rt: Runtime, linkId: string): Promise<string | null> => this.tried((c) => c.links.close(rt, linkId));
  listLinks = (): Promise<{ links: ChatLink[]; default_duration: LinkDuration } | string> => this.attempt((c) => c.links.list());
  setLinkDefault = (duration: LinkDuration): Promise<{ links: ChatLink[]; default_duration: LinkDuration } | string> =>
    this.attempt((c) => c.links.setDefault(duration));

  noDraft = (agentId: string, conversationId: string): void => {
    const was = this.snap.conversations;
    const next = was.map((x) => (x.agent_id === agentId && x.id === conversationId && x.has_draft ? { ...x, has_draft: false } : x));
    if (next.some((x, i) => x !== was[i])) this.set({ conversations: next });
  };

  clearDraft = (agentId: string, conversationId: string): void => {
    this.noDraft(agentId, conversationId);
    void this.client?.updateConversation(conversationId, { draft: null }).catch((err: unknown) => console.warn("loki: clear saved draft", err));
  };

  setPurpose = async (rt: Runtime, purpose: string): Promise<string | null> => {
    const line = purpose.replace(/\s+/g, " ").trim() || null;
    const err = await this.tried((c) => c.updateConversation(rt.conversation_id, { purpose: line }));
    if (err) return err;
    this.set({ conversations: this.snap.conversations.map((x) => (x.agent_id === rt.agent_id && x.id === rt.conversation_id ? { ...x, purpose: line } : x)) });
    return null;
  };

  cancelQueued = (rt: Runtime, text: string): void => {
    const key = keyOf(rt.agent_id, rt.conversation_id);
    const l = this.liveMap.get(key);
    if (l && dropQueued(l, text)) this.bump(key);
  };

  execute = async (rt: Runtime, commandId: string, args?: string): Promise<{ success: boolean; output: string }> => {
    const key = keyOf(rt.agent_id, rt.conversation_id);
    const l = this.liveOf(key);
    const input = commandInput(commandId, args);
    const at = () => new Date(this.now()).toISOString();
    const client = this.client;
    if (!client) {
      l.thread.finishCommand(input, false, NOT_CONNECTED, at());
      this.bump(key);
      return { success: false, output: NOT_CONNECTED };
    }
    if (!client.isSubscribed(rt)) l.thread.beginCommand(input, at());
    this.bump(key);
    try {
      const res = await client.executeCommand(rt, commandId, args);
      if (l.thread.commandRunning(input)) l.thread.finishCommand(input, res.success, res.output, at());
      this.bump(key);
      return res;
    } catch (err) {
      const message = messageOf(err);
      const reloaded = commandId === "reload" && /link closed/i.test(message);
      l.thread.finishCommand(input, reloaded, reloaded ? RELOADED : message, at());
      this.bump(key);
      return { success: reloaded, output: reloaded ? "reloaded" : message };
    }
  };

  updateAgent = async (
    agentId: string,
    body: {
      name?: string;
      description?: string;
      model?: string;
      home_mac?: string;
    },
  ): Promise<string | null> => {
    const err = await this.tried((c) => c.updateAgent(agentId, body));
    const name = body.name;
    if (!err && name) this.set({ agents: this.snap.agents.map((x) => (x.id === agentId ? { ...x, name } : x)) });
    return err;
  };

  createAgent = async (opts: NewAgentOptions): Promise<{ id: string } | { error: string }> => {
    const made = await this.attempt((c) => c.createAgent(opts));
    if (typeof made === "string") return { error: made };
    const { id, name } = made;
    if (!this.snap.agents.some((x) => x.id === id)) this.set({ agents: [...this.snap.agents, { id, name }] });
    this.reload();
    return { id };
  };

  deleteAgent = async (agentId: string): Promise<string | null> => {
    const err = await this.tried((c) => c.deleteAgent(agentId));
    if (err) return err;
    this.set({ agents: this.snap.agents.filter((x) => x.id !== agentId) });
    this.reload();
    return null;
  };

  loadProviders = async (): Promise<ConnectProvider[]> => {
    const client = this.client;
    if (!client) return [];
    try {
      const list = await client.listConnectProviders();
      this.set({ providers: list });
      return list;
    } catch {
      return this.snap.providers ?? [];
    }
  };

  connectProvider = (providerId: string, fields: Record<string, string>, authMethodId?: string): Promise<string | null> =>
    this.tried(async (c) => this.set({ providers: await c.connectProvider(providerId, fields, authMethodId) }));

  disconnectProvider = (providerId: string): Promise<string | null> => this.tried(async (c) => this.set({ providers: await c.disconnectProvider(providerId) }));

  loadLabels = (): Promise<string | null> => this.tried(async (c) => this.set({ labels: (await c.labels.get()).labels }));
  setLabels = async (rt: Runtime, next: string[]): Promise<string | null> => (await this.tried((c) => c.labels.set(rt, next))) ?? this.loadLabels();
  editLabel = async (change: Parameters<ChatClient["labels"]["edit"]>[0]): Promise<string | null> =>
    (await this.tried((c) => c.labels.edit(change))) ?? this.loadLabels();

  listModels = async () => {
    const client = this.client;
    if (!client) return [];
    return client.listModels().catch(() => []);
  };

  changeFolder = async (rt: Runtime, cwd: string): Promise<string | null> => {
    const client = this.client;
    if (!client) return NOT_CONNECTED;
    const to = cwd.trim().replace(/(.)\/+$/, "$1");
    if (!to) return "no folder";
    if (!client.isSubscribed(rt)) {
      const refused = await client.runtimeStart(rt).then(
        () => null,
        (err: unknown) => messageOf(err),
      );
      if (refused) return refused;
    }
    const key = keyOf(rt.agent_id, rt.conversation_id);
    const from = this.liveMap.get(key)?.cwd;
    this.folderMoves.get(key)?.done("replaced by a newer change");
    return new Promise<string | null>((resolve) => {
      const timer = setTimeout(() => move.done("the daemon did not answer; the folder may not have changed"), FOLDER_MOVE_MS);
      const move: FolderMove = {
        from,
        to,
        done: (err) => {
          clearTimeout(timer);
          if (this.folderMoves.get(key) === move) this.folderMoves.delete(key);
          resolve(err);
        },
      };
      this.folderMoves.set(key, move);
      client.changeFolder(rt, to).catch((err: unknown) => move.done(messageOf(err)));
    });
  };

  setMode = async (rt: Runtime, mode: string): Promise<string | null> => {
    const err = await this.tried((c) => c.runtimeStart(rt, { mode }));
    if (err) return err;
    const key = keyOf(rt.agent_id, rt.conversation_id);
    const l = this.liveMap.get(key);
    if (l) l.mode = mode;
    this.bump(key);
    return null;
  };

  archiveConversation = async (conversationId: string, archived: boolean, _origin?: ArchiveOrigin, agentId?: string): Promise<string | null> => {
    if (this.client && isMainChat(conversationId)) return "a main chat cannot be archived";
    const err = await this.tried((c) => c.updateConversation(conversationId, { archived }, agentId));
    if (err) return err;
    if (archived) {
      pruneConversationKeys(conversationId, agentId, [this.liveMap, this.faces, this.envNotes, this.threadsRead], this.dirtyKeys);
      this.set({ conversations: this.snap.conversations.filter((x) => x.id !== conversationId) });
    } else this.reload();
    return null;
  };

  archiveOutside = this.outsideActions.archiveOutside;
  markReadOutside = this.outsideActions.markReadOutside;
  markUnreadOutside = this.outsideActions.markUnreadOutside;
  labelOutside = this.outsideActions.labelOutside;
  restoreOutside = this.outsideActions.restoreOutside;
  labelsOf = this.outsideActions.labelsOf;
  readOutside = this.outsideActions.readOutside;
  replyOutside = this.outsideActions.replyOutside;
  composeOutside = this.outsideActions.composeOutside;
  reactOutside = this.outsideActions.reactOutside;
  searchEmoji = this.outsideActions.searchEmoji;
  pickPerson = this.outsideActions.pickPerson;
  searchPeople = this.outsideActions.searchPeople;
  unsendOutside = this.outsideActions.unsendOutside;
  settleUnsent = this.outsideActions.settleUnsent;
  moveOutside = this.outsideActions.moveOutside;
  handoffPropose = this.outsideActions.handoffPropose;
  handoff = this.outsideActions.handoff;

  private dropCard(card: Pick<ConversationInfo, "agent_id" | "id">): void {
    this.droppedHere = true;
    this.set({ conversations: this.snap.conversations.filter((x) => !(x.agent_id === card.agent_id && x.id === card.id)) });
  }

  renameConversation = async (conversationId: string, name: string): Promise<string | null> => {
    if (this.client && isMainChat(conversationId)) return "a main chat cannot be renamed";
    return this.tried((c) => c.renameConversation(conversationId, name));
  };

  keepMoveHere = async (rt: Runtime): Promise<string | null> => {
    const why = await this.tried((c) => c.keepMoveHere(rt));
    const key = keyOf(rt.agent_id, rt.conversation_id);
    const l = this.liveMap.get(key);
    if (!why && l) {
      l.error = null;
      this.bump(key);
    }
    return why;
  };

  abortTurn = (rt: Runtime): Promise<string | null> =>
    this.tried(async (c) => {
      await c.abortTurn(rt);
    });

  updateModel = async (rt: Runtime, selection: ModelSelection): Promise<{ applied: AppliedModel | null; error: string | null }> => {
    const applied = await this.attempt((c) => c.updateModel(rt, selection));
    if (typeof applied === "string") return { applied: null, error: applied };
    return { applied, error: null };
  };

  getPasses = async (): Promise<PassSettings | null> => {
    const client = this.client;
    if (!client) return null;
    return client.getPassSettings().catch(() => null);
  };

  setPasses = (s: PassSettingsChange): Promise<string | null> => this.tried((c) => c.setPassSettings(s));

  reflect = async (rt: Runtime): Promise<string> => {
    const r = await this.attempt((c) => c.executeCommand(rt, "reflect"));
    return typeof r === "string" ? r : r.output || (r.success ? "started" : "the harness refused");
  };

  private liveOf(key: string): Live {
    let l = this.liveMap.get(key);
    if (!l) {
      l = emptyLive();
      this.liveMap.set(key, l);
    }
    return l;
  }

  private noteFor(key: string, desk: string | null | undefined, labels?: readonly string[] | null): string | undefined {
    const note = environmentNote(this.envNotes.get(key), { desk, labels });
    this.envNotes.set(key, note.told);
    return note.text ?? undefined;
  }

  private async attempt<T>(work: (client: ChatClient) => Promise<T>): Promise<T | string> {
    const client = this.client;
    if (!client) return NOT_CONNECTED;
    return work(client).catch((err: unknown) => messageOf(err));
  }

  private async outcome(work: (client: ChatClient) => Promise<{ suggestion: Suggestion; done: boolean; message: string | null }>): Promise<SuggestionOutcome> {
    const out = await this.attempt(work);
    return typeof out === "string" ? { done: false, message: out, suggestion: null } : { done: out.done, message: out.message, suggestion: out.suggestion };
  }

  private async tried(work: (client: ChatClient) => Promise<unknown>): Promise<string | null> {
    const r = await this.attempt(async (c) => {
      await work(c);
      return null;
    });
    return r;
  }

  private set(part: Partial<ChatSnapshot>): void {
    const keys = Object.keys(part) as Array<keyof ChatSnapshot>;
    if (keys.every((k) => this.snap[k] === part[k])) return;
    this.snap = { ...this.snap, ...part };
    this.listeners.emit();
  }

  private publish(): void {
    let moved = false;
    for (const [key, l] of this.liveMap) {
      const face = faceOf(l);
      const was = this.faces.get(key);
      if (was && face.every((v, i) => v === was[i])) continue;
      this.faces.set(key, face);
      moved = true;
    }
    if (moved) this.set({ live: new Map(this.liveMap) });
    const dirty = [...this.dirtyKeys];
    this.dirtyKeys.clear();
    for (const key of dirty) this.threadWatchers.get(key)?.emit();
    this.allThreadWatchers.emit();
  }

  private bump(key?: string): void {
    if (key) this.dirtyKeys.add(key);
    this.flushing.schedule();
  }
}
