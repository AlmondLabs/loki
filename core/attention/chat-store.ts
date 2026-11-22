import { linkAnswerWords, linkAskOf, parseLinkAnswer, type ChatLink, type LinkDuration } from "../chat-links.ts";
import type { AppliedModel, ModelSelection, ReasoningEffort } from "../models.ts";
import type { LabelView } from "../labels.ts";
import { isMainChat, scopeFor } from "../desk-core.ts";
import { keepSame } from "../same-data.ts";
import type { ChatClient, NewAgentOptions } from "./chat-client.ts";
import { buildQuestionAnswer, environmentNote, isFileAttachment, withAttachments, type Attachment, type EnvNoteTold, type ImageAttachment } from "./content.ts";
import {
  applyChatEvent,
  cancelQueued as dropQueued,
  emptyLive,
  faceOf,
  folderMoveAnswer,
  keyOf,
  OUTSIDE_ENDS,
  sendMode,
  takeQueued,
  type ConversationInfo,
  type Digest,
  type Live,
} from "./model.ts";
import type { ConnectProvider, PassSettings, PassSettingsChange, Runtime } from "./protocol.ts";
import type { ReplyAction, ReplyDecideOptions, SuggestionAction } from "../frames.ts";
import type {
  AccountLabel,
  HandoffProposal,
  OutsideChange,
  OutsideMove,
  OutsideRead,
  OutsideWindowAsk,
  ReplyPersonChoice,
  ReplyProposal,
  ReplyThen,
  EmojiChoice,
  SlackPerson,
  MailAddressing,
  MailCompose,
  Suggestion,
  SuggestionTarget,
} from "../frame-types.ts";
import { commandInput, type SlashCommand } from "./commands.ts";
import { ownSendKey, type HistoryRow } from "./thread.ts";
import type { FileRef, ToolStep, TranscriptRow } from "./transcript.ts";
import { coalesce } from "../timers.ts";
import { Listeners } from "../listeners.ts";
import { messageOf } from "../errors.ts";
import { createSentReplies, sentKey } from "./sent-replies.ts";
import { PickedPeople } from "./picked-people.ts";

export type SendOrigin = "desk" | "inbox" | "lesson";

export type ArchiveOrigin = "inbox" | "inbox_undo" | "sidebar" | "chat_header" | "phone_list" | "phone_chat";

export type OutsideCardRef = Pick<ConversationInfo, "agent_id" | "id" | "outside" | "home">;

export interface OutsideWritten {
  change: OutsideChange | null;
  error: string | null;
}

export interface HistoryPage {
  rows: Array<{
    role: "user" | "assistant" | "tool" | "event";
    text: string;
    summary?: string | null;
    detail?: string | null;
    row?: number;
    at?: string | null;
    tool?: ToolStep;
    files?: FileRef[];
  }>;
  more: boolean;
  start: number;
}

export interface ChatStoreHost {
  markSeen: (agentId: string, conversationId: string) => void;
  listConversations: () => Promise<Array<ConversationInfo & Digest> | null>;
  loadLocalHistory?: (agentId: string, conversationId: string, limit?: number, before?: number) => Promise<HistoryPage | null>;
  subscribeLimit?: number;
  capture?: (event: string, properties?: Record<string, unknown>) => void;
  engage?: (agentId: string, conversationId: string, action: "decide" | "answer") => void;
  sent?: (rt: Runtime) => void;
}

export interface SuggestionOutcome {
  done: boolean;
  message: string | null;
  suggestion: Suggestion | null;
}

export interface ReplyOutcome {
  done: boolean;
  message: string | null;
  proposal: ReplyProposal | null;
}

export interface AgentEntry {
  id: string;
  name: string;
  home_mac?: string | null;
}

export interface ChatSnapshot {
  status: "off" | "connecting" | "open" | "closed";
  server: { version: string | null; protocol: number | null; advertised: SlashCommand[]; only?: string[] } | null;
  agents: AgentEntry[];
  agentsLoaded: boolean;
  listed: boolean;
  conversations: ConversationInfo[];
  digests: Map<string, Digest>;
  live: Map<string, Live>;
  older: Partial<Record<string, true>>;
  failed: Partial<Record<string, true>>;
  providers: ConnectProvider[] | null;
  labels: LabelView[] | null;
}

export const HISTORY_PAGE = 400;
const FOLDER_MOVE_MS = 8000;
const LIST_RETRY_MS = 5000;
const NOT_CONNECTED = "not connected to loki's daemon";
const NOT_OUTSIDE = "this card is not from an account";

const deskOf = (agentId: string, conversationId: string) => scopeFor(conversationId, agentId);
const withoutKey = <T>(o: Partial<Record<string, T>>, key: string): Partial<Record<string, T>> =>
  Object.fromEntries(Object.entries(o).filter(([k]) => k !== key));
const flagged = (o: Partial<Record<string, true>>, key: string, on: boolean) =>
  !!o[key] === on ? o : on ? { ...o, [key]: true as const } : withoutKey(o, key);

function outgoing(text: string, attachments: Attachment[]): { text: string; images: ImageAttachment[]; key: string } {
  const files = attachments.filter(isFileAttachment);
  const images = attachments.filter((a): a is ImageAttachment => !isFileAttachment(a));
  return { text: withAttachments(text, files), images, key: ownSendKey(text, files) };
}

function sentRow(text: string, attachments: Attachment[], at: string) {
  const files = attachments.filter(isFileAttachment).map(({ path, name, size, mime }) => ({ path, name, size, mime }));
  const images = attachments.filter((a): a is ImageAttachment => !isFileAttachment(a)).map((i) => i.url);
  return { role: "user" as const, text, ...(images.length ? { images } : {}), ...(files.length ? { files } : {}), at };
}

interface FolderMove {
  from: string | undefined;
  to: string;
  done: (err: string | null) => void;
}

export class ChatStore {
  private snap: ChatSnapshot = {
    status: "off",
    server: null,
    agents: [],
    agentsLoaded: false,
    listed: false,
    conversations: [],
    digests: new Map(),
    live: new Map(),
    older: {},
    failed: {},
    providers: null,
    labels: null,
  };
  private readonly listeners = new Listeners();
  private readonly threadWatchers = new Listeners();
  private readonly liveMap = new Map<string, Live>();
  private readonly threadsRead = new Map<string, Runtime>();
  private readonly faces = new Map<string, readonly unknown[]>();
  private client: ChatClient | null = null;
  private readonly flushing = coalesce(() => this.publish(), 150);
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

  subscribe = (listener: () => void): (() => void) => {
    return this.listeners.add(listener);
  };

  getSnapshot = (): ChatSnapshot => this.snap;

  watchThreads = (onChange: () => void): (() => void) => {
    return this.threadWatchers.add(onChange);
  };

  threadRows = (agentId: string, conversationId: string): TranscriptRow[] | undefined => this.liveMap.get(keyOf(agentId, conversationId))?.thread.rows();

  turnOf = (agentId: string, conversationId: string): string | null => this.liveMap.get(keyOf(agentId, conversationId))?.turnId ?? null;

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
        for (const l of this.liveMap.values()) if (l.thread.settleCommands()) changed = true;
        if (changed) this.bump();
      }
    });
    let reloadTimer: ReturnType<typeof setTimeout> | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
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
      void client
        .serverInfo()
        .then((info) => {
          if (!cancelled)
            this.set({ server: keepSame(this.snap.server, { version: info.version, protocol: info.protocol, advertised: [], only: info.commands }) });
        })
        .catch(() => {});
      const agents = await client.listAgents();
      if (cancelled) return;
      const next = agents.filter((a) => a.hidden !== true).map((a) => ({ id: a.id, name: a.name ?? "agent", home_mac: a.home_mac ?? null }));
      this.set({ agents: keepSame(this.snap.agents, next), agentsLoaded: true });
      const rows = await this.host().listConversations();
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
        this.set({
          conversations: convs,
          digests: new Map(
            rows.map((r) => [keyOf(r.agent_id, r.id), { last_role: r.last_role, last_assistant_text: r.last_assistant_text, last_ask: r.last_ask }]),
          ),
        });
      }
      this.set({ listed: true });
      for (const c of convs.filter((x) => !x.outside).slice(0, this.host().subscribeLimit ?? 30)) {
        const rt: Runtime = { agent_id: c.agent_id, conversation_id: c.id };
        // react-doctor-disable-next-line react-doctor/async-await-in-loop
        if (!client.isSubscribed(rt)) await client.runtimeStart(rt).catch(() => {});
        if (stopped()) return;
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
    const asked = { approval: l.pending?.requestId ?? null, question: l.pendingAsk?.requestId ?? null };
    const errorBefore = l.error;
    let changed = false;
    let userSpoke = false;
    for (const e of events) {
      const r = applyChatEvent(l, e);
      changed ||= r.changed;
      userSpoke ||= r.userSpoke;
    }
    const request =
      l.pending && l.pending.requestId !== asked.approval
        ? { id: l.pending.requestId, tool: l.pending.toolName, kind: "approval" }
        : l.pendingAsk && l.pendingAsk.requestId !== asked.question
          ? { id: l.pendingAsk.requestId, tool: "user_ask", kind: "question" }
          : null;
    const move = this.folderMoves.get(key);
    const answer = move ? folderMoveAnswer(events, l.cwd, move) : null;
    if (move && answer === "moved") move.done(null);
    else if (move && answer && answer !== "moved") {
      move.done(answer.error);
      l.error = errorBefore;
    }
    const host = this.host();
    if (request)
      host.capture?.("approval_requested", { desk: deskOf(agent, conv), agent, tool: request.tool, kind: request.kind, once: `request:${request.id}` });
    if (userSpoke) host.markSeen(agent, conv);
    if (changed) this.bump();
    if (wasInTurn && !l.inTurn) {
      const next = takeQueued(l);
      if (next) {
        const out = outgoing(next.text, next.images);
        l.thread.expectEcho(out.key);
        l.inTurn = true;
        this.bump();
        void client
          .sendUserMessage(rt, out.text, out.images, this.noteFor(key, next.desk, next.labels))
          .catch((err: unknown) => console.warn("loki: queued send", err));
      }
    }
    return changed;
  }

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
    const l = this.liveMap.get(keyOf(rt.agent_id, rt.conversation_id));
    const was = l?.pending?.requestId === requestId ? l.pending : null;
    if (l && was) l.pending = null;
    const host = this.host();
    host.markSeen(rt.agent_id, rt.conversation_id);
    host.engage?.(rt.agent_id, rt.conversation_id, "decide");
    host.capture?.("approval_decided", {
      desk: deskOf(rt.agent_id, rt.conversation_id),
      agent: rt.agent_id,
      turn_id: l?.turnId ?? null,
      behavior,
      wait_ms: was ? Math.max(0, this.now() - Date.parse(was.at)) || null : null,
    });
    this.bump();
    void this.client
      ?.respondApproval(rt, requestId, behavior)
      .catch(() => false)
      .then((ok) => {
        if (ok || !l || !was) return;
        l.pending ??= was;
        this.bump();
      });
  };

  answer = (rt: Runtime, requestId: string, answers: Record<string, string | string[]>): void => {
    const l = this.liveMap.get(keyOf(rt.agent_id, rt.conversation_id));
    const was = l?.pendingAsk?.requestId === requestId ? l.pendingAsk : null;
    if (!l || !was) return;
    l.pendingAsk = null;
    const link = linkAskOf(was.input);
    const summary = link
      ? linkAnswerWords(link, parseLinkAnswer(answers))
      : Object.values(answers)
          .map((a) => (Array.isArray(a) ? a.join(", ") : a))
          .join(" · ");
    if (summary.trim()) l.thread.own({ role: "user", text: summary, at: new Date(this.now()).toISOString() });
    const host = this.host();
    host.markSeen(rt.agent_id, rt.conversation_id);
    host.engage?.(rt.agent_id, rt.conversation_id, "answer");
    host.capture?.("question_answered", {
      desk: deskOf(rt.agent_id, rt.conversation_id),
      agent: rt.agent_id,
      wait_ms: Math.max(0, this.now() - Date.parse(was.at)) || null,
    });
    this.bump();
    void this.client
      ?.answerQuestion(rt, requestId, buildQuestionAnswer(was.input, answers))
      .catch(() => false)
      .then((ok) => {
        if (ok) return;
        l.pendingAsk ??= was;
        this.bump();
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
    const fileCount = images.filter(isFileAttachment).length;
    const host = this.host();
    host.capture?.("message_sent", {
      desk: deskOf(rt.agent_id, rt.conversation_id),
      agent: rt.agent_id,
      turn_id: l.turnId ?? null,
      origin: env.origin ?? null,
      images: images.length - fileCount,
      files: fileCount,
      queued: l.inTurn,
    });
    host.sent?.(rt);
    const at = new Date(this.now()).toISOString();
    const mode = sendMode(l);
    if (mode === "queue") {
      l.queued.push({ text, images, desk: env.desk, labels: env.labels });
      l.thread.queue(sentRow(text, images, at));
      this.bump();
      return;
    }
    const out = outgoing(text, images);
    l.thread.own(sentRow(text, images, at), out.key);
    l.lastRole = "user";
    this.bump();
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
        this.bump();
      });
    host.markSeen(rt.agent_id, rt.conversation_id);
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
    const l = this.liveMap.get(keyOf(rt.agent_id, rt.conversation_id));
    if (l && dropQueued(l, text)) this.bump();
  };

  execute = async (rt: Runtime, commandId: string, args?: string): Promise<{ success: boolean; output: string }> => {
    const l = this.liveOf(keyOf(rt.agent_id, rt.conversation_id));
    const input = commandInput(commandId, args);
    const at = () => new Date(this.now()).toISOString();
    this.host().capture?.("command_run", { command: commandId });
    const client = this.client;
    if (!client) {
      l.thread.finishCommand(input, false, NOT_CONNECTED, at());
      this.bump();
      return { success: false, output: NOT_CONNECTED };
    }
    if (!client.isSubscribed(rt)) l.thread.beginCommand(input, at());
    this.bump();
    try {
      const res = await client.executeCommand(rt, commandId, args);
      if (l.thread.commandRunning(input)) l.thread.finishCommand(input, res.success, res.output, at());
      this.bump();
      return res;
    } catch (err) {
      const message = messageOf(err);
      const reloaded = commandId === "reload" && /link closed/i.test(message);
      l.thread.finishCommand(input, reloaded, reloaded ? "reloaded — the mod restarted and the link is back" : message, at());
      this.bump();
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
      advisor_model?: string | null;
      advisor_reasoning_effort?: ReasoningEffort | null;
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
          if (!err) this.host().capture?.("folder_changed", { desk: deskOf(rt.agent_id, rt.conversation_id), agent: rt.agent_id });
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
    const l = this.liveMap.get(keyOf(rt.agent_id, rt.conversation_id));
    if (l) l.mode = mode;
    this.host().capture?.("mode_set", { mode });
    this.bump();
    return null;
  };

  archiveConversation = async (conversationId: string, archived: boolean, origin?: ArchiveOrigin, agentId?: string): Promise<string | null> => {
    if (this.client && isMainChat(conversationId)) return "a main chat cannot be archived";
    const err = await this.tried((c) => c.updateConversation(conversationId, { archived }, agentId));
    if (err) return err;
    if (origin)
      this.host().capture?.(archived ? "chat_archived" : "chat_restored", {
        desk: scopeFor(conversationId),
        origin,
        ...(archived ? { turn_id: [...this.liveMap].find(([key]) => key.endsWith(`/${conversationId}`))?.[1].turnId ?? null } : {}),
      });
    if (archived) this.set({ conversations: this.snap.conversations.filter((x) => x.id !== conversationId) });
    else this.reload();
    return null;
  };

  archiveOutside = async (card: OutsideCardRef): Promise<OutsideWritten> => {
    if (card.outside && !OUTSIDE_ENDS[card.outside.provider].archive) return { change: null, error: "a jira card ends with read" };
    const r = await this.writeOutside(card, (c, o, home) => c.archiveOutside(o.account_id, o.thread_id, home));
    if (!r.error) this.dropCard(card);
    return r;
  };

  markReadOutside = (card: OutsideCardRef): Promise<OutsideWritten> =>
    this.writeOutside(card, (c, o, home) => c.markReadOutside(o.account_id, o.thread_id, home));

  markUnreadOutside = (card: OutsideCardRef): Promise<OutsideWritten> =>
    this.writeOutside(card, (c, o, home) => c.markUnreadOutside(o.account_id, o.thread_id, home));

  labelOutside = (card: OutsideCardRef, labels: string[]): Promise<OutsideWritten> =>
    this.writeOutside(card, (c, o, home) => c.labelOutside(o.account_id, o.thread_id, labels, home));

  restoreOutside = async (card: OutsideCardRef, change: OutsideChange): Promise<string | null> => {
    const o = card.outside;
    if (!o) return NOT_OUTSIDE;
    const err = await this.tried((c) => c.restoreOutside(o.account_id, o.thread_id, change, card.home ?? null));
    if (!err && change.ended) this.reload();
    return err;
  };

  labelsOf = async (card: Pick<ConversationInfo, "outside" | "home">): Promise<AccountLabel[] | string> => {
    const o = card.outside;
    if (!o) return NOT_OUTSIDE;
    return this.attempt((c) => c.labelsOutside(o.account_id, card.home ?? null));
  };

  private async writeOutside(
    card: OutsideCardRef,
    work: (client: ChatClient, outside: NonNullable<ConversationInfo["outside"]>, home: string | null) => Promise<OutsideChange | null>,
  ): Promise<OutsideWritten> {
    const o = card.outside;
    if (!o) return { change: null, error: NOT_OUTSIDE };
    const r = await this.attempt((c) => work(c, o, card.home ?? null));
    if (typeof r === "string") return { change: null, error: r };
    if (r?.ended) this.dropCard(card);
    return { change: r, error: null };
  }

  private dropCard(card: Pick<ConversationInfo, "agent_id" | "id">): void {
    this.droppedHere = true;
    this.set({ conversations: this.snap.conversations.filter((x) => !(x.agent_id === card.agent_id && x.id === card.id)) });
  }

  readOutside = async (card: Pick<ConversationInfo, "outside" | "home">, ask: OutsideWindowAsk = {}): Promise<OutsideRead | string> => {
    const o = card.outside;
    if (!o) return "this card is not from an account";
    return this.attempt((c) => c.readOutside(o.account_id, o.thread_id, card.home ?? null, ask));
  };

  replyOutside = async (
    card: Pick<ConversationInfo, "agent_id" | "id" | "outside" | "home">,
    text: string,
    then: ReplyThen,
    extra: { mail?: MailAddressing | null; outbox_id?: string | null; thread_ts?: string | null } = {},
  ): Promise<{ sent: boolean; error: string | null; change: OutsideChange | null; undone?: true }> => {
    const o = card.outside;
    if (!o) return { sent: false, error: "this card is not from an account", change: null };
    const place = sentKey(o.account_id, o.thread_id, extra.thread_ts ?? null);
    const shown = then === "stay" ? this.sent.add(place, text.trim(), new Date(this.now()).toISOString()) : null;
    const mentions = this.picked.in(o.account_id, text);
    const r = await this.attempt((c) => c.replyOutside(o.account_id, o.thread_id, text, then, card.home ?? null, { ...extra, mentions }));
    if (shown) {
      if (typeof r === "string" || !r.sent) this.sent.drop(shown);
      else this.sent.went(shown);
    }
    if (typeof r === "string") return { sent: false, error: r, change: null };
    if (!r.sent) return { sent: false, error: null, change: null, undone: true };
    if (r.change?.ended) this.dropCard(card);
    return { sent: true, error: r.then_error, change: r.change };
  };

  composeOutside = async (card: Pick<ConversationInfo, "outside" | "home">): Promise<MailCompose | string> => {
    const o = card.outside;
    if (o?.provider !== "gmail") return "this card is not a mail";
    return this.attempt((c) => c.composeOutside(o.account_id, o.thread_id, card.home ?? null));
  };

  reactOutside = async (card: Pick<ConversationInfo, "outside" | "home">, messageId: string, name: string, on: boolean): Promise<string | null> => {
    const o = card.outside;
    if (o?.provider !== "slack") return "only a Slack message takes a reaction";
    const r = await this.attempt((c) => c.reactOutside(o.account_id, o.thread_id, messageId, name, on, card.home ?? null));
    return typeof r === "string" ? r : null;
  };

  searchEmoji = async (card: Pick<ConversationInfo, "outside" | "home">, query: string): Promise<EmojiChoice[] | string> => {
    const o = card.outside;
    if (o?.provider !== "slack") return "only a Slack message takes a reaction";
    return this.attempt((c) => c.searchEmoji(o.account_id, query, card.home ?? null));
  };

  readonly picked = new PickedPeople();

  pickPerson = (card: Pick<ConversationInfo, "outside">, person: SlackPerson): void => {
    const o = card.outside;
    if (o?.provider === "slack") this.picked.add(o.account_id, { display: person.name, id: person.id, address: null });
  };

  searchPeople = async (card: Pick<ConversationInfo, "outside" | "home">, query: string): Promise<SlackPerson[] | string> => {
    const o = card.outside;
    if (o?.provider !== "slack") return "only a Slack account has people to mention";
    return this.attempt((c) => c.searchPeople(o.account_id, query, card.home ?? null));
  };

  unsendOutside = async (card: Pick<ConversationInfo, "outside" | "home">, outboxId: string): Promise<boolean> => {
    const o = card.outside;
    if (!o) return false;
    const r = await this.attempt((c) => c.unsendOutside(o.account_id, outboxId, card.home ?? null));
    return r === true;
  };

  settleUnsent = async (card: Pick<ConversationInfo, "outside" | "home">, outboxId: string, action: "resend" | "discard"): Promise<string | null> => {
    const o = card.outside;
    if (!o) return NOT_OUTSIDE;
    const home = card.home ?? null;
    if (action === "discard") {
      const r = await this.attempt((c) => c.discardOutside(o.account_id, outboxId, home));
      if (typeof r === "string") return r;
      this.reload();
      return null;
    }
    const r = await this.attempt((c) => c.resendOutside(o.account_id, o.thread_id, outboxId, home));
    if (typeof r === "string") return r;
    this.reload();
    return r.sent && r.then_error ? `sent, but ${r.then_error}` : null;
  };

  moveOutside = (card: Pick<ConversationInfo, "outside" | "home">, move: OutsideMove): void => {
    const o = card.outside;
    if (o) void this.tried((c) => c.moveOutside(o.account_id, o.thread_id, move, card.home ?? null));
  };

  handoffPropose = async (card: Pick<ConversationInfo, "outside" | "home">): Promise<HandoffProposal | string> => {
    const o = card.outside;
    if (!o) return "this card is not from an account";
    return this.attempt((c) => c.handoffPropose(o.account_id, o.thread_id, card.home ?? null));
  };

  handoff = async (card: Pick<ConversationInfo, "agent_id" | "id" | "outside" | "home">, conversationId: string | null): Promise<string | null> => {
    const o = card.outside;
    if (!o) return "this card is not from an account";
    const err = await this.tried((c) => c.handoff(o.account_id, o.thread_id, conversationId, card.home ?? null));
    if (err) return err;
    if (!OUTSIDE_ENDS[o.provider].handoff) return null;
    this.set({ conversations: this.snap.conversations.filter((x) => !(x.agent_id === card.agent_id && x.id === card.id)) });
    return null;
  };

  renameConversation = async (conversationId: string, name: string): Promise<string | null> => {
    if (this.client && isMainChat(conversationId)) return "a main chat cannot be renamed";
    return this.tried((c) => c.renameConversation(conversationId, name));
  };

  keepMoveHere = async (rt: Runtime): Promise<string | null> => {
    const why = await this.tried((c) => c.keepMoveHere(rt));
    const l = this.liveMap.get(keyOf(rt.agent_id, rt.conversation_id));
    if (!why && l) {
      l.error = null;
      this.bump();
    }
    return why;
  };

  abortTurn = (rt: Runtime): Promise<string | null> =>
    this.tried(async (c) => {
      const turnId = this.turnOf(rt.agent_id, rt.conversation_id);
      const aborted = await c.abortTurn(rt);
      this.host().capture?.("turn_stopped", { aborted, turn_id: turnId });
    });

  updateModel = async (rt: Runtime, selection: ModelSelection): Promise<{ applied: AppliedModel | null; error: string | null }> => {
    const applied = await this.attempt((c) => c.updateModel(rt, selection));
    if (typeof applied === "string") return { applied: null, error: applied };
    this.host().capture?.("model_switched", { model: applied.handle, effort: applied.reasoning_effort });
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
    this.threadWatchers.emit();
  }

  private bump(): void {
    this.flushing.schedule();
  }
}
