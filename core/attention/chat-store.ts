import type { AppliedModel, ModelSelection } from "../models.ts";
import type { LabelView } from "../labels.ts";
import { scopeFor } from "../desk-core.ts";
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
  sendMode,
  takeQueued,
  type ConversationInfo,
  type Digest,
  type Live,
} from "./model.ts";
import type { ConnectProvider, PassSettings, PassSettingsChange, Runtime } from "./protocol.ts";
import type { SuggestionAction } from "../frames.ts";
import type { Suggestion, SuggestionTarget } from "../frame-types.ts";
import { commandInput, type SlashCommand } from "./commands.ts";
import { ownSendKey, type HistoryRow } from "./thread.ts";
import type { FileRef, ToolStep, TranscriptRow } from "./transcript.ts";
import { coalesce } from "../timers.ts";
import { Listeners } from "../listeners.ts";
import { messageOf } from "../errors.ts";

/**
 * Every chat this client follows, outside React (plan 052): the list and its digests, the agents, the live half of
 * each chat (its thread, approvals, questions, queue and folder moves) and the calls that change them. useAttention
 * reads it through `subscribe` and `getSnapshot`; a test drives it with a fake ChatClient and no React at all.
 *
 * Two speeds of change: the snapshot moves when the list or a chat's face does (a new approval, a turn starting), and
 * `watchThreads` hears every streamed piece, so a reply redraws only the thread drawing it (plan 032).
 */

/** Where a message was typed, for analytics; the phone's sends carry none (its device type says). */
export type SendOrigin = "desk" | "inbox" | "lesson";

/** Where a chat was archived or restored from, for analytics (chat_archived / chat_restored). */
export type ArchiveOrigin = "inbox" | "inbox_undo" | "sidebar" | "chat_header" | "phone_list" | "phone_chat";

/** A page of a chat's thread, as the mod reads it from the daemon's store (plan 041). */
export interface HistoryPage {
  rows: Array<{
    role: "user" | "assistant" | "tool" | "event";
    text: string;
    summary?: string | null;
    detail?: string | null;
    /** On an event sent lean (plan 043): where its detail is (TranscriptRow's `row`). */
    row?: number;
    at?: string | null;
    tool?: ToolStep;
    files?: FileRef[];
  }>;
  more: boolean;
  /** Where the rows start in the chat's whole thread; a paired Mac on an older loki leaves it out. */
  start?: number;
}

/** What the store asks of the app, read at call time: the host builds these afresh on every render. */
export interface ChatStoreHost {
  markSeen: (agentId: string, conversationId: string) => void;
  /** Every open conversation with its digest, from the mod (inbox_list). */
  listConversations: () => Promise<Array<ConversationInfo & Digest>>;
  /** A page of a chat's thread, through the mod; null when no page came. `before`: the page ends before that position. */
  loadLocalHistory?: (agentId: string, conversationId: string, limit?: number, before?: number) => Promise<HistoryPage | null>;
  /** How many of the newest conversations to follow for live events. */
  subscribeLimit?: number;
  /** Analytics (core/analytics.ts): an event this store carried out for the person. */
  capture?: (event: string, properties?: Record<string, unknown>) => void;
  /** Tell the mod about an engagement only the app sees (a decision, an answer). */
  engage?: (agentId: string, conversationId: string, action: "decide" | "answer") => void;
  /** A message went into this conversation (the model picker's recent list moves its model to the front). */
  sent?: (rt: Runtime) => void;
}

/**
 * What a person's action on a suggestion came to (plan 049): whether it took, the reason when it did not (another
 * device acted first, the target is gone, the Mac is out of reach), and the suggestion as it then stands, when known.
 */
export interface SuggestionOutcome {
  done: boolean;
  message: string | null;
  suggestion: Suggestion | null;
}

/** An agent as the lists show it. */
export interface AgentEntry {
  id: string;
  name: string;
  home_mac?: string | null;
}

/** Everything the store holds that the app draws, the same object until some of it changes. */
export interface ChatSnapshot {
  status: "off" | "connecting" | "open" | "closed";
  /** From the chat client's serverInfo: the daemon's name and the commands it runs. */
  server: { version: string | null; protocol: number | null; advertised: SlashCommand[]; only?: string[] } | null;
  agents: AgentEntry[];
  /** False until the first agent list answered: an empty list before that means nothing. */
  agentsLoaded: boolean;
  /** False until the chat list first came: before that, a chat missing from it is not yet known to be gone. */
  listed: boolean;
  /** The open conversations, newest first. */
  conversations: ConversationInfo[];
  digests: Map<string, Digest>;
  /** Each chat's live state as render sees it: a fresh map each time a chat's face moves. */
  live: Map<string, Live>;
  /** Chats whose log holds rows older than the ones loaded. */
  older: Partial<Record<string, true>>;
  /** Chats whose first page did not come (plan 041). */
  failed: Partial<Record<string, true>>;
  /** The provider catalogue, null until asked for. */
  providers: ConnectProvider[] | null;
  /** The labels every chip takes its colour from (plan 022), null until loaded. */
  labels: LabelView[] | null;
}

/** How many rows of a chat's log a page is (the mod's HISTORY_PAGE): the first load, and each older page after it. */
export const HISTORY_PAGE = 400;
/** How long a folder change waits for the daemon's answer. */
const FOLDER_MOVE_MS = 8000;
/** What every call says while the mod's socket is down. */
const NOT_CONNECTED = "not connected to loki's daemon";

/** A chat's id in analytics: its desk scope, as the mod's turn events carry it. */
const deskOf = (agentId: string, conversationId: string) => scopeFor(conversationId, agentId);
/** A flag map without `key`. */
const withoutKey = <T>(o: Partial<Record<string, T>>, key: string): Partial<Record<string, T>> =>
  Object.fromEntries(Object.entries(o).filter(([k]) => k !== key));
/** A flag map with `key` set or cleared, the same map when it already was. */
const flagged = (o: Partial<Record<string, true>>, key: string, on: boolean) =>
  !!o[key] === on ? o : on ? { ...o, [key]: true as const } : withoutKey(o, key);

/**
 * A message as it goes out: images ride inside it, files as their attachment tags after the text; `key` is how
 * its echo is recognised (ownSendKey), empty when there is nothing to recognise.
 */
function outgoing(text: string, attachments: Attachment[]): { text: string; images: ImageAttachment[]; key: string } {
  const files = attachments.filter(isFileAttachment);
  const images = attachments.filter((a): a is ImageAttachment => !isFileAttachment(a));
  return { text: withAttachments(text, files), images, key: ownSendKey(text, files) };
}

/** A message's row as it shows at once: the text, its images, and chips for its files. */
function sentRow(text: string, attachments: Attachment[], at: string) {
  const files = attachments.filter(isFileAttachment).map(({ path, name, size, mime }) => ({ path, name, size, mime }));
  const images = attachments.filter((a): a is ImageAttachment => !isFileAttachment(a)).map((i) => i.url);
  return { role: "user" as const, text, ...(images.length ? { images } : {}), ...(files.length ? { files } : {}), at };
}

/** A folder change waiting on the daemon's answer (changeFolder). */
interface FolderMove {
  from: string | undefined;
  to: string;
  done: (err: string | null) => void;
}

/** The chats this client follows, and the calls that change them. */
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
  /** The live map the handlers change in place; `snap.live` is its copy as last published. */
  private readonly liveMap = new Map<string, Live>();
  /** Each chat's face as last published (faceOf): what a flush compares to tell a list change from a thread change. */
  private readonly faces = new Map<string, readonly unknown[]>();
  private client: ChatClient | null = null;
  /** Publish within 150 ms of the first change: a burst of streamed pieces draws once. */
  private readonly flushing = coalesce(() => this.publish(), 150);
  /** How many rows each chat's history was last asked for (HISTORY_PAGE more per page), on an older Mac. */
  private readonly historyLimits = new Map<string, number>();
  private readonly loading = new Set<string>();
  /** What each chat's agent was last told of the time and the chat: the note goes again only when that changed. */
  private readonly envNotes = new Map<string, EnvNoteTold>();
  private readonly folderMoves = new Map<string, FolderMove>();
  /** Conversations the list knows; an event from another means the list is stale. */
  private known = new Set<string>();
  private lastReload = 0;
  /** The link dropped since it was last open: when it reopens, commands left running are settled. */
  private linkDropped = false;
  /** Whether the page is shown: the list poll skips while it is not (plan 047). */
  private visible = true;
  /** The current connection's list load, null while disconnected. */
  private reloadNow: (() => void) | null = null;

  private current: ChatStoreHost;
  private readonly now: () => number;

  /** `now` is the clock; the host may change, as the app builds it afresh on every render (setHost). */
  constructor(host: ChatStoreHost, now: () => number = Date.now) {
    this.current = host;
    this.now = now;
  }

  /** The app's latest calls, read at each use from here on. */
  setHost(host: ChatStoreHost): void {
    this.current = host;
  }

  private host(): ChatStoreHost {
    return this.current;
  }

  /** Hear each change to the snapshot; returns the way to stop. */
  subscribe = (listener: () => void): (() => void) => {
    return this.listeners.add(listener);
  };

  /** What the app draws, the same object until some of it changes. */
  getSnapshot = (): ChatSnapshot => this.snap;

  /** Hear every flush, for the threads on screen (useThreadRows); returns the way to stop. */
  watchThreads = (onChange: () => void): (() => void) => {
    return this.threadWatchers.add(onChange);
  };

  /** A chat's rows as they stand now, the same array until they change (ThreadModel.rows). */
  threadRows = (agentId: string, conversationId: string): TranscriptRow[] | undefined => this.liveMap.get(keyOf(agentId, conversationId))?.thread.rows();

  /** The turn running in a chat, or the last one that ran: what client events join the daemon's turn_finished by. */
  turnOf = (agentId: string, conversationId: string): string | null => this.liveMap.get(keyOf(agentId, conversationId))?.turnId ?? null;

  /** Whether the page is shown; back in view, nothing is owed, the next poll or reload reads the list. */
  setVisible(shown: boolean): void {
    this.visible = shown;
  }

  /** Read the list now (the sidebar archived or restored something); otherwise it refreshes each minute. */
  reload = (): void => this.reloadNow?.();

  /**
   * Follow the daemon through `client` until the returned function is called: its status, every chat's events, the
   * agents and the list (now, each minute while shown, and whenever the mod says the lists went stale).
   */
  connect(client: ChatClient): () => void {
    this.client = client;
    const offStatus = client.onStatus((s) => {
      this.set({ status: s });
      if (s === "closed") this.linkDropped = true;
      else if (s === "open") {
        // Labels are read once the daemon is there, for every chip on this client.
        void this.loadLabels();
        if (!this.linkDropped) return;
        // Back after a drop (a /reload restarts the mod, which is this link): finish what the old link left running.
        this.linkDropped = false;
        let changed = false;
        for (const l of this.liveMap.values()) if (l.thread.settleCommands()) changed = true;
        if (changed) this.bump();
      }
    });
    let reloadTimer: ReturnType<typeof setTimeout> | null = null;
    const off = client.onChat((rt, events) => {
      const changed = this.heard(client, rt, events);
      const key = keyOf(rt.agent_id, rt.conversation_id);
      if (changed && !this.known.has(key) && !reloadTimer && this.now() - this.lastReload > 10_000) {
        // Not in the list yet: refresh it soon so the conversation can become a card.
        reloadTimer = setTimeout(() => {
          reloadTimer = null;
          this.reload();
        }, 1500);
      }
    });
    let cancelled = false;
    /** The list's last answer on this connection, to tell a repeat from a change. */
    let lastRows: unknown = null;
    /** Whether the connection was let go: read through a call, since it changes while the load awaits. */
    const stopped = () => cancelled;
    const loadOnce = async () => {
      void client
        .serverInfo()
        .then((info) => {
          // The daemon runs exactly its own commands; the palette offers those and loki's.
          if (!cancelled)
            this.set({ server: keepSame(this.snap.server, { version: info.version, protocol: info.protocol, advertised: [], only: info.commands }) });
        })
        .catch(() => {});
      const agents = await client.listAgents();
      if (cancelled) return;
      const next = agents.filter((a) => a.hidden !== true).map((a) => ({ id: a.id, name: a.name ?? "agent", home_mac: a.home_mac ?? null }));
      this.set({ agents: keepSame(this.snap.agents, next), agentsLoaded: true });
      // The list and the digests are the mod's, in one answer: nothing is windowed or capped here.
      const rows = await this.host().listConversations();
      if (stopped()) return;
      this.lastReload = this.now();
      // The same answer as last time changes nothing (plan 047): the poll and every reload no longer redraw the app.
      const same = keepSame(lastRows, rows) === lastRows;
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
      // Live events (approvals, questions, streaming) need the chat opened on the daemon (chat_open); the newest are.
      for (const c of convs.slice(0, this.host().subscribeLimit ?? 30)) {
        const rt: Runtime = { agent_id: c.agent_id, conversation_id: c.id };
        // A conversation that cannot be reached still lists; it just has no live half. One at a time, newest first, on
        // purpose: the daemon opens each chat in turn rather than up to 30 at once, and a disconnect stops the rest.
        // react-doctor-disable-next-line react-doctor/async-await-in-loop
        if (!client.isSubscribed(rt)) await client.runtimeStart(rt).catch(() => {});
        if (stopped()) return;
      }
    };
    const load = () => void loadOnce().catch((err: unknown) => console.warn("loki catch up:", err));
    this.reloadNow = load;
    load();
    // The poll is the fallback; an agent changed elsewhere, a reconnect or a return from the background asks at once.
    const poll = setInterval(() => {
      if (this.visible) load();
    }, 60_000);
    const offStale = client.onListsStale(load);
    return () => {
      cancelled = true;
      clearInterval(poll);
      offStale();
      offStatus();
      if (reloadTimer) clearTimeout(reloadTimer);
      off();
      client.close();
      if (this.client === client) {
        this.client = null;
        this.reloadNow = null;
      }
      this.set({ status: "off" });
    };
  }

  /** Stop the pending flush: nothing is left to draw into. */
  dispose(): void {
    this.flushing.cancel();
  }

  /** A batch of a chat's events: applied, then what they decide (a new request, a folder answer, a queued send). Whether the chat changed. */
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
    // A new permission request or question. Every window and phone sees the same one; the mod keeps the first report (`once`).
    const request =
      l.pending && l.pending.requestId !== asked.approval
        ? { id: l.pending.requestId, tool: l.pending.toolName, kind: "approval" }
        : l.pendingAsk && l.pendingAsk.requestId !== asked.question
          ? { id: l.pendingAsk.requestId, tool: "user_ask", kind: "question" }
          : null;
    // A folder change waiting on its answer (changeFolder): the new folder in a device status, or a loop error.
    const move = this.folderMoves.get(key);
    const answer = move ? folderMoveAnswer(events, l.cwd, move) : null;
    if (move && answer === "moved") move.done(null);
    else if (move && answer && answer !== "moved") {
      move.done(answer.error);
      l.error = errorBefore; // the refusal is the folder dialog's to show; the chat did not fail
    }
    const host = this.host();
    if (request)
      host.capture?.("approval_requested", { desk: deskOf(agent, conv), agent, tool: request.tool, kind: request.kind, once: `request:${request.id}` });
    if (userSpoke) host.markSeen(agent, conv);
    if (changed) this.bump();
    // The turn just ended and something was typed during it: it goes out now, one per turn end.
    if (wasInTurn && !l.inTurn) {
      const next = takeQueued(l);
      if (next) {
        const out = outgoing(next.text, next.images);
        l.thread.expectEcho(out.key);
        l.inTurn = true; // until the server says so, so a second queued message waits its turn
        this.bump();
        void client
          .sendUserMessage(rt, out.text, out.images, this.noteFor(key, next.desk, next.labels))
          .catch((err: unknown) => console.warn("loki: queued send", err));
      }
    }
    return changed;
  }

  /** Load a chat's thread: the newest page, with older pages already read kept in front of it (plan 033). */
  loadThread = async (rt: Runtime): Promise<void> => {
    const key = keyOf(rt.agent_id, rt.conversation_id);
    if (this.loading.has(key)) return;
    this.loading.add(key);
    const read = async () => {
      const thread = this.liveOf(key).thread;
      // A paired Mac on an older loki pages by a growing limit instead, and its answer replaces what was loaded.
      const limit = thread.firstPosition === null ? (this.historyLimits.get(key) ?? HISTORY_PAGE) : HISTORY_PAGE;
      const page = await this.host().loadLocalHistory?.(rt.agent_id, rt.conversation_id, limit);
      // A page that did not come leaves a thread never loaded unloaded, not empty; one already loaded stays as it is.
      const unreached = page === null;
      this.set({ failed: flagged(this.snap.failed, key, unreached && thread.rows() === undefined) });
      if (unreached) return;
      const rows: HistoryRow[] = page?.rows ?? [];
      thread.load(rows, page?.start);
      const first = thread.firstPosition;
      this.set({ older: flagged(this.snap.older, key, first === null ? !!page?.more : first > 0) });
      this.publish();
    };
    await read().catch((err: unknown) => console.warn("loki: thread", err));
    this.loading.delete(key);
  };

  /** The next page of a chat's history, older than what is loaded, put in front of it (plan 033). */
  loadOlder = (rt: Runtime): void => {
    const key = keyOf(rt.agent_id, rt.conversation_id);
    if (this.loading.has(key)) return;
    const thread = this.liveOf(key).thread;
    const before = thread.firstPosition;
    if (before === null) {
      this.historyLimits.set(key, (this.historyLimits.get(key) ?? HISTORY_PAGE) + HISTORY_PAGE);
      void this.loadThread(rt);
      return;
    }
    this.loading.add(key);
    const read = async () => {
      const page = await this.host().loadLocalHistory?.(rt.agent_id, rt.conversation_id, HISTORY_PAGE, before);
      if (page?.start !== undefined) thread.prepend(page.rows, page.start);
      const first = thread.firstPosition;
      this.set({ older: flagged(this.snap.older, key, first !== null && first > 0) });
      this.publish();
    };
    void read()
      .catch((err: unknown) => console.warn("loki: older thread", err))
      .then(() => this.loading.delete(key));
  };

  /** A new conversation under an agent, in a folder: the runtime of the desk it becomes. */
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

  /** Follow a conversation that is not among the recent ones (the desk's, say). */
  follow = async (rt: Runtime): Promise<void> => {
    const client = this.client;
    if (!client || client.isSubscribed(rt)) return;
    await client.runtimeStart(rt).catch((err: unknown) => console.warn("loki: subscribe", err));
  };

  /** Decide a pending approval: the card clears at once, and comes back if the daemon refuses. */
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
    void this.client?.respondApproval(rt, requestId, behavior).then((ok) => {
      if (ok || !l || !was) return;
      l.pending ??= was; // the server refused: put the request back
      this.bump();
    });
  };

  /** Answer a pending question (the user_ask tool); the card clears at once and comes back if the daemon refuses. */
  answer = (rt: Runtime, requestId: string, answers: Record<string, string | string[]>): void => {
    const l = this.liveMap.get(keyOf(rt.agent_id, rt.conversation_id));
    const was = l?.pendingAsk?.requestId === requestId ? l.pendingAsk : null;
    if (!l || !was) return;
    l.pendingAsk = null;
    const summary = Object.values(answers)
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
    void this.client?.answerQuestion(rt, requestId, buildQuestionAnswer(was.input, answers)).then((ok) => {
      if (ok) return;
      l.pendingAsk ??= was;
      this.bump();
    });
  };

  /**
   * Send a message into a conversation. Shown at once; the server's echo of it is recognised and not shown twice. During
   * a turn it joins the turn, or on an agent waits for its end (sendMode), and goes out when the turn ends.
   */
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
      .catch((err: unknown) => console.warn("loki: send", err));
    host.markSeen(rt.agent_id, rt.conversation_id);
  };

  /**
   * The person's actions on a chat's suggestions (plan 049), carried out by the Mac the chat lives on. The new state
   * reaches every client as the chat's `suggestions` event, so nothing here changes the live state itself.
   */
  decideSuggestion = (rt: Runtime, suggestionId: string, action: SuggestionAction): Promise<SuggestionOutcome> =>
    this.outcome((c) => c.suggestions.decide(rt, suggestionId, action));

  /** Point a suggestion at another chat, or at a new chat with an agent in a folder, before acting on it (R4). */
  retargetSuggestion = (rt: Runtime, suggestionId: string, target: SuggestionTarget): Promise<SuggestionOutcome> =>
    this.outcome((c) => c.suggestions.retarget(rt, suggestionId, target));

  /** The chat holds no saved draft any more (plan 049, KTD7): its Inbox mark goes without waiting for the list. */
  noDraft = (agentId: string, conversationId: string): void => {
    const was = this.snap.conversations;
    const next = was.map((x) => (x.agent_id === agentId && x.id === conversationId && x.has_draft ? { ...x, has_draft: false } : x));
    if (next.some((x, i) => x !== was[i])) this.set({ conversations: next });
  };

  /** A message box emptied of its saved draft: the draft goes here at once, and from the chat on the daemon. */
  clearDraft = (agentId: string, conversationId: string): void => {
    this.noDraft(agentId, conversationId);
    void this.client?.updateConversation(conversationId, { draft: null }).catch((err: unknown) => console.warn("loki: clear saved draft", err));
  };

  /**
   * Give a chat its one-line purpose (plan 049, R11), or clear it with an empty one; resolves to an error message or
   * null. The list has it at once, so the header shows it before the list is read again.
   */
  setPurpose = async (rt: Runtime, purpose: string): Promise<string | null> => {
    const line = purpose.replace(/\s+/g, " ").trim() || null;
    const err = await this.tried((c) => c.updateConversation(rt.conversation_id, { purpose: line }));
    if (err) return err;
    this.set({ conversations: this.snap.conversations.map((x) => (x.agent_id === rt.agent_id && x.id === rt.conversation_id ? { ...x, purpose: line } : x)) });
    return null;
  };

  /** Take back a message typed mid-turn before it went out. */
  cancelQueued = (rt: Runtime, text: string): void => {
    const l = this.liveMap.get(keyOf(rt.agent_id, rt.conversation_id));
    if (l && dropQueued(l, text)) this.bump();
  };

  /**
   * A slash command for the harness (/reload, /compact …). The transcript row comes from the harness's deltas when the
   * conversation is followed; the answer here fills the row in when those never arrived, or when the call failed.
   */
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
    if (!client.isSubscribed(rt)) l.thread.beginCommand(input, at()); // no deltas will come for this one: show the running row here
    this.bump();
    try {
      const res = await client.executeCommand(rt, commandId, args);
      if (l.thread.commandRunning(input)) l.thread.finishCommand(input, res.success, res.output, at());
      this.bump();
      return res;
    } catch (err) {
      const message = messageOf(err);
      // /reload restarts the mod, and the mod is this link: the answer is lost with it, which is the success case.
      const reloaded = commandId === "reload" && /link closed/i.test(message);
      l.thread.finishCommand(input, reloaded, reloaded ? "reloaded — the mod restarted and the link is back" : message, at());
      this.bump();
      return { success: reloaded, output: reloaded ? "reloaded" : message };
    }
  };

  /** Change an agent; resolves to an error message or null. */
  updateAgent = async (agentId: string, body: { name?: string; description?: string; model?: string; home_mac?: string }): Promise<string | null> => {
    const err = await this.tried((c) => c.updateAgent(agentId, body));
    const name = body.name;
    if (!err && name) this.set({ agents: this.snap.agents.map((x) => (x.id === agentId ? { ...x, name } : x)) });
    return err;
  };

  /** A new agent with its name, description, persona and model, in one request; the lists reload. */
  createAgent = async (opts: NewAgentOptions): Promise<{ id: string } | { error: string }> => {
    const made = await this.attempt((c) => c.createAgent(opts));
    if (typeof made === "string") return { error: made };
    const { id, name } = made;
    if (!this.snap.agents.some((x) => x.id === id)) this.set({ agents: [...this.snap.agents, { id, name }] });
    this.reload();
    return { id };
  };

  /** Delete an agent; resolves to an error message or null, and the lists reload. */
  deleteAgent = async (agentId: string): Promise<string | null> => {
    const err = await this.tried((c) => c.deleteAgent(agentId));
    if (err) return err;
    this.set({ agents: this.snap.agents.filter((x) => x.id !== agentId) });
    this.reload();
    return null;
  };

  /** The provider catalogue, read now; the last one read when this read fails. */
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

  /** Connect a model provider; resolves to an error message or null. */
  connectProvider = (providerId: string, fields: Record<string, string>, authMethodId?: string): Promise<string | null> =>
    this.tried(async (c) => this.set({ providers: await c.connectProvider(providerId, fields, authMethodId) }));

  /** Disconnect a model provider; resolves to an error message or null. */
  disconnectProvider = (providerId: string): Promise<string | null> => this.tried(async (c) => this.set({ providers: await c.disconnectProvider(providerId) }));

  /** Read the labels again (plan 022); resolves to an error message or null. */
  loadLabels = (): Promise<string | null> => this.tried(async (c) => this.set({ labels: (await c.labels.get()).labels }));

  /** Give a chat its labels, then read them all again. */
  setLabels = async (rt: Runtime, next: string[]): Promise<string | null> => (await this.tried((c) => c.labels.set(rt, next))) ?? this.loadLabels();

  /** Rename, recolour or delete a label everywhere, then read them all again. */
  editLabel = async (change: Parameters<ChatClient["labels"]["edit"]>[0]): Promise<string | null> =>
    (await this.tried((c) => c.labels.edit(change))) ?? this.loadLabels();

  /** The models the daemon offers; none while it cannot be reached. */
  listModels = async () => {
    const client = this.client;
    if (!client) return [];
    return client.listModels().catch(() => []);
  };

  /**
   * Move a conversation to another folder; resolves to an error or null once the daemon has answered (a device status
   * with the new folder, or an error), or after FOLDER_MOVE_MS with no answer. The chat's tools run there from its next turn.
   */
  changeFolder = async (rt: Runtime, cwd: string): Promise<string | null> => {
    const client = this.client;
    if (!client) return NOT_CONNECTED;
    const to = cwd.trim().replace(/(.)\/+$/, "$1");
    if (!to) return "no folder";
    if (!client.isSubscribed(rt)) {
      // Its device status and errors come to followers only.
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

  /** Set a conversation's permission mode; resolves to an error message or null. */
  setMode = async (rt: Runtime, mode: string): Promise<string | null> => {
    const err = await this.tried((c) => c.runtimeStart(rt, { mode }));
    if (err) return err;
    const l = this.liveMap.get(keyOf(rt.agent_id, rt.conversation_id));
    if (l) l.mode = mode;
    this.host().capture?.("mode_set", { mode });
    this.bump();
    return null;
  };

  /**
   * Archive or restore a conversation; resolves to an error message or null. Main chats cannot be archived.
   * Archiving is how a chat leaves the Inbox, so it goes from the list at once; a restore reads the list again.
   */
  archiveConversation = async (conversationId: string, archived: boolean, origin?: ArchiveOrigin): Promise<string | null> => {
    if (this.client && conversationId === "default") return "a main chat cannot be archived";
    const err = await this.tried((c) => c.updateConversation(conversationId, { archived }));
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

  /** Rename a conversation; resolves to an error message or null. Main chats are named after their agent. */
  renameConversation = async (conversationId: string, name: string): Promise<string | null> => {
    if (this.client && conversationId === "default") return "a main chat cannot be renamed";
    return this.tried((c) => c.renameConversation(conversationId, name));
  };

  /** Stop a conversation's turn (the composer's stop button); resolves to an error message or null. */
  abortTurn = (rt: Runtime): Promise<string | null> =>
    this.tried(async (c) => {
      const turnId = this.turnOf(rt.agent_id, rt.conversation_id);
      const aborted = await c.abortTurn(rt);
      this.host().capture?.("turn_stopped", { aborted, turn_id: turnId });
    });

  /** Switch a conversation's model; the applied handle and effort, or an error. */
  updateModel = async (rt: Runtime, selection: ModelSelection): Promise<{ applied: AppliedModel | null; error: string | null }> => {
    const applied = await this.attempt((c) => c.updateModel(rt, selection));
    if (typeof applied === "string") return { applied: null, error: applied };
    this.host().capture?.("model_switched", { model: applied.handle, effort: applied.reasoning_effort });
    return { applied, error: null };
  };

  /** Whether reflection and Learn run (daemon/passes.ts); null while it cannot be read. */
  getPasses = async (): Promise<PassSettings | null> => {
    const client = this.client;
    if (!client) return null;
    return client.getPassSettings().catch(() => null);
  };

  /** Turn reflection or Learn on or off; resolves to an error message or null. */
  setPasses = (s: PassSettingsChange): Promise<string | null> => this.tried((c) => c.setPassSettings(s));

  /** A reflection pass started by hand, the same as /reflect in that chat: what the harness said. */
  reflect = async (rt: Runtime): Promise<string> => {
    const r = await this.attempt((c) => c.executeCommand(rt, "reflect"));
    return typeof r === "string" ? r : r.output || (r.success ? "started" : "the harness refused");
  };

  /** A conversation's live state, made on first use: its thread holds the chat's rows, loaded and live. */
  private liveOf(key: string): Live {
    let l = this.liveMap.get(key);
    if (!l) {
      l = emptyLive();
      this.liveMap.set(key, l);
    }
    return l;
  }

  /** The environment note a message to this chat carries as it goes out (none when nothing changed), remembered. */
  private noteFor(key: string, desk: string | null | undefined, labels?: readonly string[] | null): string | undefined {
    const note = environmentNote(this.envNotes.get(key), { desk, labels });
    this.envNotes.set(key, note.told);
    return note.text ?? undefined;
  }

  /** One call to the daemon: its answer, or why not in words. */
  private async attempt<T>(work: (client: ChatClient) => Promise<T>): Promise<T | string> {
    const client = this.client;
    if (!client) return NOT_CONNECTED;
    return work(client).catch((err: unknown) => messageOf(err));
  }

  /** A suggestion action's outcome; one that did not get through leaves the suggestion as it was, with the reason. */
  private async outcome(work: (client: ChatClient) => Promise<{ suggestion: Suggestion; done: boolean; message: string | null }>): Promise<SuggestionOutcome> {
    const out = await this.attempt(work);
    return typeof out === "string" ? { done: false, message: out, suggestion: null } : { done: out.done, message: out.message, suggestion: out.suggestion };
  }

  /** One call to the daemon whose answer is only whether it took: null, or why not in words. */
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

  /**
   * Hand the live state to render (plan 032). A streaming reply moves only its thread, so the snapshot stays as it is
   * and only that thread's watchers draw again; a chat's face moving (a new approval, a turn starting) moves the snapshot.
   */
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

  /** Publish soon (`flushing`): a burst of streamed pieces draws once. */
  private bump(): void {
    this.flushing.schedule();
  }
}
