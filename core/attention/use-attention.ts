import type { FileRef, ToolStep, WholeRow } from "./transcript.ts";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { Runtime } from "./protocol.ts";
import type { ChatClient, NewAgentOptions } from "./chat-client.ts";
import type { AppliedModel, ChatEngineView, ModelSelection } from "../models.ts";
import type { ConnectProvider, PassSettings } from "./protocol.ts";
import {
  applyChatEvent,
  folderMoveAnswer,
  buildItems,
  cancelQueued as dropQueued,
  chatStatusOf,
  emptyLive,
  faceOf,
  keyOf,
  sendMode,
  takeQueued,
  type AttentionItem,
  type ConversationInfo,
  type Digest,
  type Live,
  type PendingApproval,
  type PendingQuestion,
} from "./model.ts";
import { buildQuestionAnswer, environmentNote, isFileAttachment, withAttachments, type Attachment, type EnvNoteTold } from "./content.ts";
import type { TranscriptRow } from "./transcript.ts";
import { ownSendKey, type HistoryRow } from "./thread.ts";
import type { ImageAttachment } from "./content.ts";
import { idOf, inboxQueue } from "./queue.ts";
import { createActiveClock, type Activity } from "./active-clock.ts";
import { focusShares, type FocusEntry } from "./focus.ts";
import { movesOn, restAfterNext, restUndone, type Rest } from "./rest.ts";
import { allCommands, commandInput, type SlashCommand } from "./commands.ts";
import type { PayloadOf, SuggestionAction } from "../frames.ts";
import type { LabelView } from "../labels.ts";
import type { Suggestion, SuggestionTarget } from "../frame-types.ts";

/** An engagement only the app sees (core/frames.ts focus_add): the mod counts messages and opens itself. */
export type EngageAction = PayloadOf<"focus_add">["action"];
import { scopeFor } from "../desk-core.ts";

/** What you did with an Inbox card: moved on, archived it (done), decided an approval, replied, or answered its question. */
export type CardAction = "next" | "archive" | "approve" | "deny" | "reply" | "answer" | "open";

/** How a card was acted on: a key or a click on the Mac, a swipe or a tap on the phone. */
export type CardVia = "key" | "click" | "swipe" | "tap";
/** Where a chat was archived or restored from, for analytics (chat_archived / chat_restored). */
export type ArchiveOrigin = "inbox" | "inbox_undo" | "sidebar" | "chat_header" | "phone_list" | "phone_chat";

/** How long a folder change waits for the daemon's answer. */
const FOLDER_MOVE_MS = 8000;

/** A chat's id in analytics: its desk scope, as the mod's turn events carry it. */
const deskOf = (agentId: string, conversationId: string) => scopeFor(conversationId, agentId);
const minutesSince = (iso: string | null, now: number): number | null => {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isNaN(t) ? null : Math.max(0, Math.round((now - t) / 60_000));
};

/** What the app hands useAttention: the mod's socket state, seen and viewed markers, focus weights, and the calls that reach the mod for lists, history and markers. */
export interface UseAttentionOptions {
  /** Whether the mod's socket is up, which carries the chats. */
  enabled: boolean;
  seen: Record<string, string>;
  /** When each conversation was last looked at (the mod's viewed markers); a look is not done. */
  viewed?: Record<string, string>;
  /** Each chat's focus weight (the mod's, core/attention/focus.ts): what the inbox ranks by after blocked agents. */
  focus?: Record<string, FocusEntry>;
  /** Tell the mod about an engagement only the app sees (a decision, an answer). */
  engage?: (agentId: string, conversationId: string, action: EngageAction) => void;
  /** Each chat's Inbox rest (the mod's, core/attention/rest.ts): a resting card stays out of the Inbox until due. */
  rests?: Record<string, Rest>;
  /** Tell the mod a card was rested by Next, or its rest undone. */
  rest?: (agentId: string, conversationId: string, rest: Rest) => void;
  markSeen: (agentId: string, conversationId: string) => void;
  unmarkSeen: (agentId: string, conversationId: string) => void;
  /** Full transcript from the daemon's store, through the mod (compaction-proof); null when no page came (plan 041). */
  loadLocalHistory?: (
    agentId: string,
    conversationId: string,
    limit?: number,
    /** The position of the oldest row loaded: the page ends before it (plan 033); absent, the newest rows. */
    before?: number,
  ) => Promise<{
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
  } | null>;
  /** What a page left out of a lean row (plans 041 and 043), from the Mac the chat lives on; null when it did not come. */
  loadLocalStep?: (agentId: string, conversationId: string, row: number) => Promise<WholeRow | null>;
  /** Every open conversation with its digest, from the mod (inbox_list). The list is the inbox's; only live events come from the chat client. */
  listConversations: () => Promise<Array<ConversationInfo & Digest>>;
  /** How many of the newest conversations to subscribe to for live events (each is a chat the daemon follows and pushes to this socket). */
  subscribeLimit?: number;
  /** Analytics (core/analytics.ts): an event this model carried out for the user. */
  capture?: (event: string, properties?: Record<string, unknown>) => void;
  /** A message went into this conversation (the model picker's recent list moves its model to the front). */
  sent?: (rt: Runtime) => void;
  /** When loki's window is in front of you, so a card's dwell counts only that time; left out, always. */
  activity?: Activity;
  /** The chat client for loki's daemon, over the mod's frames (core/attention/chat-client.ts). */
  makeClient: () => ChatClient;
}

/** Where a message was typed, for analytics; the phone's sends carry none (its device type says). */
export type SendOrigin = "desk" | "inbox" | "lesson";

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
function sentRow(
  text: string,
  attachments: Attachment[],
): { role: "user"; text: string; images?: string[]; files?: Array<{ path: string; name: string; size: number; mime: string }>; at: string } {
  const files = attachments.filter(isFileAttachment).map(({ path, name, size, mime }) => ({ path, name, size, mime }));
  const images = attachments.filter((a): a is ImageAttachment => !isFileAttachment(a)).map((i) => i.url);
  return { role: "user", text, ...(images.length ? { images } : {}), ...(files.length ? { files } : {}), at: new Date().toISOString() };
}

/** The environment note a message to this chat carries as it goes out (none when nothing changed), remembered. */
function noteFor(told: Map<string, EnvNoteTold>, key: string, desk: string | null | undefined, labels?: readonly string[] | null): string | undefined {
  const note = environmentNote(told.get(key), { desk, labels });
  told.set(key, note.told);
  return note.text ?? undefined;
}

/** A conversation as a chat surface reads it from useAttention's `conversation`: everything but its rows. */
export interface ChatFace {
  status: "idle" | "thinking" | "streaming";
  pending: PendingApproval | null;
  question: PendingQuestion | null;
  error: string | null;
  mode: string | null;
  cwd: string | null;
  engine: ChatEngineView | null;
  older: (() => void) | null;
  /** The thread's first page did not come (plan 041): load it again. Null while it loads, once it came, or before it is asked for. */
  loadFailed: (() => void) | null;
  /** Fetch what a page left out of a lean row: a tool row's step (plan 041), an event's detail (plan 043). */
  loadStep: (row: number) => Promise<WholeRow | null>;
  /** The suggestions made in this chat that wait on the person or are being sent (plan 047), for its chat screen. */
  suggestions: Suggestion[];
}

/**
 * What a person's action on a suggestion came to (plan 047): whether it took, the reason when it did not (another
 * device acted first, the target is gone, the Mac is out of reach), and the suggestion as it then stands, when known.
 */
export interface SuggestionOutcome {
  done: boolean;
  message: string | null;
  suggestion: Suggestion | null;
}

/** A conversation as a chat surface draws it (useConversation): its face and its rows, undefined until asked for. */
export interface ChatView extends ChatFace {
  rows: TranscriptRow[] | undefined;
}

/** The parts of useAttention's result a chat surface reads a conversation through. */
export interface ChatViews {
  conversation: (agentId: string, conversationId: string) => ChatFace;
  watchThreads: (onChange: () => void) => () => void;
  threadRows: (agentId: string, conversationId: string) => TranscriptRow[] | undefined;
}

/**
 * One conversation for a chat surface, redrawn when its rows move (plan 032): useAttention's result changes only when
 * the list does, so a streaming reply reaches the thread drawing it and nothing else. Null without both ids.
 */
export function useConversation(chats: ChatViews, agentId: string, conversationId: string): ChatView;
export function useConversation(chats: ChatViews, agentId: string | null, conversationId: string | null): ChatView | null;
export function useConversation(chats: ChatViews, agentId: string | null, conversationId: string | null): ChatView | null {
  const rows = useThreadRows(chats, agentId, conversationId);
  if (!agentId || !conversationId) return null;
  return { ...chats.conversation(agentId, conversationId), rows };
}

/**
 * A conversation's rows alone, redrawn as they move: for the part of a surface that draws the thread, so a streamed
 * piece redraws that part and not the header and box around it (plan 032). Undefined until loaded, or without both ids.
 */
export function useThreadRows(
  chats: Pick<ChatViews, "watchThreads" | "threadRows">,
  agentId: string | null,
  conversationId: string | null,
): TranscriptRow[] | undefined {
  const read = () => (agentId && conversationId ? chats.threadRows(agentId, conversationId) : undefined);
  return useSyncExternalStore(chats.watchThreads, read, read);
}

/** The saved draft's text on an Inbox row (plan 047, KTD7), which the mod sends as `draft_text`; null when it has none. */
function draftTextOf(c: ConversationInfo): string | null {
  return (c.has_draft === true && c.draft_text) || null;
}

/**
 * The suggestions saved as drafts, by chat (plan 047, KTD7): the text each chat's message box shows while nothing is
 * typed in it, as the Inbox list last had it. useAttention keeps it; the app's message-box drafts read it beneath
 * what is typed (app/src/shared/drafts.ts) and say when a box that held one was emptied. Typing never reaches it.
 */
export function createSavedDrafts() {
  let texts = new Map<string, string>();
  const subs = new Set<() => void>();
  let emptiedOnDaemon: (agentId: string, conversationId: string) => void = () => {};
  const emit = () => subs.forEach((fn) => fn());
  const drop = (agentId: string, conversationId: string): boolean => {
    const key = keyOf(agentId, conversationId);
    if (!texts.has(key)) return false;
    texts = new Map(texts);
    texts.delete(key);
    emit();
    return true;
  };
  return {
    /** The chat's saved draft, or null. */
    text: (agentId: string, conversationId: string): string | null => texts.get(keyOf(agentId, conversationId)) ?? null,
    /** The saved drafts as the list now has them, by `keyOf`; readers are told only when something changed. */
    replace(next: ReadonlyMap<string, string>) {
      if (next.size === texts.size && [...next].every(([k, t]) => texts.get(k) === t)) return;
      texts = new Map(next);
      emit();
    },
    /** The chat sent: its draft is spent here at once (the daemon clears its own on the send). */
    drop,
    /** A box that held the draft was emptied: it goes here at once, and from the chat on the daemon. */
    emptied(agentId: string, conversationId: string) {
      if (drop(agentId, conversationId)) emptiedOnDaemon(agentId, conversationId);
    },
    /** What emptying does on the daemon (useAttention's), until the returned call takes it back. */
    onEmptied(fn: (agentId: string, conversationId: string) => void): () => void {
      emptiedOnDaemon = fn;
      return () => {
        if (emptiedOnDaemon === fn) emptiedOnDaemon = () => {};
      };
    },
    subscribe(fn: () => void): () => void {
      subs.add(fn);
      return () => subs.delete(fn);
    },
  };
}
/** A saved-drafts registry, as `createSavedDrafts` returns it. */
export type SavedDrafts = ReturnType<typeof createSavedDrafts>;

/** The client's saved drafts: one useAttention runs per page, the shell's or the phone's. */
export const savedDrafts = createSavedDrafts();

/** No suggestions: one array, so a chat's face stays the same while it has none. */
const NO_SUGGESTIONS: Suggestion[] = [];

/** A flag map without `key`. */
const withoutKey = <T>(o: Partial<Record<string, T>>, key: string): Partial<Record<string, T>> =>
  Object.fromEntries(Object.entries(o).filter(([k]) => k !== key));

/** How many rows of a chat's log a page is (the mod's HISTORY_PAGE): the first load, and each older page after it. */
export const HISTORY_PAGE = 400;

/** The Inbox's state and actions for a client, the Mac app or the phone: the open conversations and their digests come from the mod (inbox_list), the live half (approvals, questions, streaming) from the daemon through the mod's chat frames for the newest few, and the seen markers from the mod. Returns the scored items, each chat's thread, and the calls that send, decide, archive and manage agents. */
export function useAttention(opts: UseAttentionOptions) {
  const [conversations, setConversations] = useState<ConversationInfo[]>([]);
  const [agents, setAgents] = useState<Array<{ id: string; name: string; home_mac?: string | null }>>([]);
  /** False until the first agent_list answered: an empty list before that means nothing. */
  const [agentsLoaded, setAgentsLoaded] = useState(false);
  /** False until the chat list first came: before that, a chat missing from it is not yet known to be gone. */
  const [listed, setListed] = useState(false);
  const [digests, setDigests] = useState<Map<string, Digest>>(new Map());
  /**
   * The live map as render sees it: a fresh copy each time a flush finds a chat's face moved (publish). The handlers
   * mutate `liveRef` in place; the threads inside are read through useConversation.
   */
  const [live, setLive] = useState<Map<string, Live>>(() => new Map());
  const [status, setStatus] = useState<"off" | "connecting" | "open" | "closed">("off");
  /** From the chat client's serverInfo: the daemon's name and the commands it runs. */
  const [server, setServer] = useState<{ version: string | null; protocol: number | null; advertised: SlashCommand[]; only?: string[] } | null>(null);
  /** Chats whose log holds rows older than the ones loaded; the reader reaching the top asks for the next page. */
  const [older, setOlder] = useState<Partial<Record<string, true>>>({});
  /** Chats whose first page did not come (plan 041): their thread says so and offers to try again. */
  const [failed, setFailed] = useState<Partial<Record<string, true>>>({});
  /** How many rows each chat's history was last asked for (HISTORY_PAGE more per page). */
  const historyLimits = useRef(new Map<string, number>());
  const loading = useRef(new Set<string>());
  const socketRef = useRef<ChatClient | null>(null);
  const liveRef = useRef(new Map<string, Live>());
  /** A conversation's live state, made on first use: its thread holds the chat's rows, loaded and live. */
  const liveOf = useCallback((key: string): Live => {
    let l = liveRef.current.get(key);
    if (!l) {
      l = emptyLive();
      liveRef.current.set(key, l);
    }
    return l;
  }, []);
  /** What each chat's agent was last told of the time and the chat: the note goes again only when that changed. */
  const envNotes = useRef(new Map<string, EnvNoteTold>());
  /** Folder changes waiting on the daemon's answer, by conversation key (changeFolder). */
  const folderMoves = useRef(new Map<string, { from: string | undefined; to: string; done: (err: string | null) => void }>());
  const notifyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Conversations the list knows about; an event from an unknown one means the list is stale (a new desk, an empty conversation that just got its first turn). */
  const knownRef = useRef(new Set<string>());
  const reloadRef = useRef<(() => void) | null>(null);
  const lastReload = useRef(0);
  /** The link dropped since it was last open: when it reopens, commands left running are settled (see settleCommands). */
  const linkDropped = useRef(false);

  /**
   * The latest options, for the actions below. The host builds `opts` afresh on every render (and the mod's calls
   * in it), so an action that closed over it would be new each time too, and so would everything this hook
   * returns; read at call time instead, the actions stay the same functions.
   */
  const optsRef = useRef(opts);
  useEffect(() => {
    optsRef.current = opts;
  });

  /** Re-read the list now (the sidebar archived or restored something); otherwise it refreshes each minute. Stable, so effects can depend on it. */
  const reload = useCallback(() => reloadRef.current?.(), []);

  /** Each chat's face as last rendered (faceOf): what a flush compares to tell a list change from a thread change. */
  const faces = useRef(new Map<string, readonly unknown[]>());
  /** Every useConversation on screen, told on each flush; each one redraws only when its own rows moved. */
  const threadWatchers = useRef(new Set<() => void>());
  /**
   * Hand the live state to render (plan 032). A streaming reply moves only its thread, so the list, the Inbox and
   * everything else holding this hook's result stay as they are, and only that thread's watchers draw again.
   */
  const publish = useCallback(() => {
    let moved = false;
    for (const [key, l] of liveRef.current) {
      const face = faceOf(l);
      const was = faces.current.get(key);
      if (was && face.every((v, i) => v === was[i])) continue;
      faces.current.set(key, face);
      moved = true;
    }
    if (moved) setLive(new Map(liveRef.current));
    for (const watch of threadWatchers.current) watch();
  }, []);
  const bump = useCallback(() => {
    if (notifyTimer.current) return;
    notifyTimer.current = setTimeout(() => {
      notifyTimer.current = null;
      publish();
    }, 150);
  }, [publish]);
  /** Watch every thread for useConversation; returns the way to stop. Stable. */
  const watchThreads = useCallback((onChange: () => void) => {
    threadWatchers.current.add(onChange);
    return () => {
      threadWatchers.current.delete(onChange);
    };
  }, []);
  /** A chat's rows as they stand now, the same array until they change (ThreadModel.rows). Stable. */
  const threadRows = useCallback((agentId: string, conversationId: string) => liveRef.current.get(keyOf(agentId, conversationId))?.thread.rows(), []);

  // Connect / disconnect with `enabled`.
  useEffect(() => {
    if (!opts.enabled) return;
    // loki's daemon serves chats through the mod's own frames (plan 017, U5).
    const sock: ChatClient = optsRef.current.makeClient();
    sock.onStatus = (s) => {
      setStatus(s);
      if (s === "closed") linkDropped.current = true;
      else if (s === "open" && linkDropped.current) {
        // Back after a drop (a /reload restarts the mod, which is this link): finish what the old link left running.
        linkDropped.current = false;
        let changed = false;
        for (const l of liveRef.current.values()) if (l.thread.settleCommands()) changed = true;
        if (changed) bump();
      }
    };
    socketRef.current = sock;
    let reloadTimer: ReturnType<typeof setTimeout> | null = null; // a list refresh waiting on this socket
    const off = sock.onChat((rt, events) => {
      const { conversation_id: conv, agent_id: agent } = rt;
      const key = keyOf(agent, conv);
      const l = liveOf(key);
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
      // A new permission request or question (approval_requested). Every window and phone sees the same request; the
      // mod keeps the first report of each (`once`).
      const request =
        l.pending && l.pending.requestId !== asked.approval
          ? { id: l.pending.requestId, tool: l.pending.toolName, kind: "approval" }
          : l.pendingAsk && l.pendingAsk.requestId !== asked.question
            ? { id: l.pendingAsk.requestId, tool: "user_ask", kind: "question" }
            : null;
      // A folder change waiting on its answer (changeFolder): the new folder in a device status, or a loop error.
      const move = folderMoves.current.get(key);
      const answer = move ? folderMoveAnswer(events, l.cwd, move) : null;
      if (move && answer === "moved") move.done(null);
      else if (move && answer && answer !== "moved") {
        move.done(answer.error);
        l.error = errorBefore; // the refusal is the folder dialog's to show; the chat did not fail
      }
      if (request)
        optsRef.current.capture?.("approval_requested", {
          desk: deskOf(agent, conv),
          agent,
          tool: request.tool,
          kind: request.kind,
          once: `request:${request.id}`,
        });
      if (userSpoke) optsRef.current.markSeen(agent, conv);
      if (changed) bump();
      // The turn just ended and something was typed during it: it goes out now, one per turn end.
      if (wasInTurn && !l.inTurn) {
        const next = takeQueued(l);
        if (next) {
          const out = outgoing(next.text, next.images);
          l.thread.expectEcho(out.key);
          l.inTurn = true; // until the server says so, so a second queued message waits its turn
          bump();
          void sock
            .sendUserMessage(rt, out.text, out.images, noteFor(envNotes.current, key, next.desk, next.labels))
            .catch((err: unknown) => console.warn("loki: queued send", err));
        }
      }
      if (changed && !knownRef.current.has(key) && !reloadTimer && Date.now() - lastReload.current > 10_000) {
        // not in the list yet: refresh it soon so the conversation can become a card
        reloadTimer = setTimeout(() => {
          reloadTimer = null;
          reloadRef.current?.();
        }, 1500);
      }
    });

    let cancelled = false;
    /** Whether the cleanup has run: read through a call, since it changes while the load awaits. */
    const stopped = () => cancelled;
    const subscribeLimit = optsRef.current.subscribeLimit ?? 30;
    // Promise-style error handling here: the React Compiler cannot take a loop or a ?? inside a try block.
    const loadOnce = async () => {
      void sock
        .serverInfo()
        .then((info) => {
          // The daemon runs exactly its own commands; the palette offers those and loki's.
          if (!cancelled) setServer({ version: info.version, protocol: info.protocol, advertised: [], only: info.commands });
        })
        .catch(() => {});
      const agents = await sock.listAgents();
      const shown = new Map(agents.filter((a) => a.hidden !== true).map((a) => [a.id, a]));
      if (!cancelled) {
        setAgents([...shown.values()].map((a) => ({ id: a.id, name: a.name ?? "agent", home_mac: a.home_mac ?? null })));
        setAgentsLoaded(true);
      }
      // The list and the digests are the mod's, in one answer: nothing is windowed or capped here.
      const rows = await optsRef.current.listConversations();
      if (cancelled) return;
      const convs: ConversationInfo[] = rows
        .map(({ last_role: _r, last_assistant_text: _t, last_ask: _a, ...c }) => c)
        .sort((a, b) => (b.last_message_at ?? "").localeCompare(a.last_message_at ?? ""));
      lastReload.current = Date.now();
      knownRef.current = new Set(convs.map((c) => keyOf(c.agent_id, c.id)));
      setConversations(convs);
      setListed(true);
      setDigests(
        new Map(rows.map((r) => [keyOf(r.agent_id, r.id), { last_role: r.last_role, last_assistant_text: r.last_assistant_text, last_ask: r.last_ask }])),
      );
      // Live events (approvals, questions, streaming) need the chat opened on the daemon (chat_open); the newest are.
      for (const c of convs.slice(0, subscribeLimit)) {
        const rt: Runtime = { agent_id: c.agent_id, conversation_id: c.id };
        // a conversation we cannot reach still lists; it just has no live half
        if (!sock.isSubscribed(rt)) await sock.runtimeStart(rt).catch(() => {});
        if (stopped()) return;
      }
    };
    const load = () => loadOnce().catch((err: unknown) => console.warn("loki catch up:", err));
    reloadRef.current = () => void load();
    void load();
    // The poll is the fallback; an agent changed elsewhere, a reconnect or a return from the background asks at once.
    const refresh = setInterval(() => void load(), 60_000);
    const offStale = sock.onListsStale(() => void load());
    return () => {
      cancelled = true;
      clearInterval(refresh);
      offStale();
      if (reloadTimer) clearTimeout(reloadTimer);
      off();
      sock.close();
      socketRef.current = null;
      setStatus("off");
    };
  }, [opts.enabled, bump, liveOf]);

  // The pending tick, if any, has nothing to render into after unmount.
  useEffect(
    () => () => {
      if (notifyTimer.current) clearTimeout(notifyTimer.current);
      notifyTimer.current = null;
    },
    [],
  );

  // The clock tick: focus fades and cards age without any other event, so the items are rebuilt twice a minute.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);
  const items = useMemo(
    () => buildItems(conversations, digests, live, opts.seen, now, opts.viewed, focusShares(opts.focus ?? {}, now), opts.rests),
    [conversations, digests, opts.seen, opts.viewed, opts.focus, opts.rests, live, now],
  );

  /**
   * The Inbox's analytics, for tuning the ranking against what you actually do. Each card event carries where the
   * card stood in the Inbox (rank among `of`), what it scored and why, whether it was new and how long its chat had
   * been quiet, read from the live items at that moment. A card shown (inbox_card_shown) starts its dwell clock; the
   * decision (inbox_card_decided) says how long it was on top before you acted, counting only the time loki was
   * visible and focused (active-clock.ts).
   */
  const itemsRef = useRef(items);
  useEffect(() => {
    itemsRef.current = items;
  });
  const shownAt = useRef(new Map<string, number>());
  const [clock] = useState(() => createActiveClock());
  const activity = opts.activity;
  useEffect(() => activity?.((on) => clock.set(on)), [activity, clock]);
  /** The turn running in a chat, or the last one that ran: what client events join the daemon's turn_finished by. */
  const turnOf = useCallback((agentId: string, conversationId: string) => liveRef.current.get(keyOf(agentId, conversationId))?.turnId ?? null, []);
  const cardProps = useCallback(
    (item: AttentionItem) => {
      const queue = inboxQueue(itemsRef.current);
      const at = queue.findIndex((i) => idOf(i) === idOf(item));
      const it = queue[at] ?? item;
      return {
        desk: deskOf(item.agent_id, item.id),
        agent: item.agent_id,
        turn_id: turnOf(item.agent_id, item.id),
        rank: at >= 0 ? at + 1 : null,
        of: queue.length,
        score: Math.round(it.score * 10) / 10,
        focus: Math.round(it.focus * 100) / 100,
        reason: it.reason,
        status: it.status,
        new: it.unread,
        idle_min: minutesSince(it.last_message_at, Date.now()),
        rung: it.rung ?? 0,
        rested: it.rested ?? false,
      };
    },
    [turnOf],
  );
  const shown = useCallback(
    (item: AttentionItem) => {
      shownAt.current.set(idOf(item), clock.now());
      optsRef.current.capture?.("inbox_card_shown", cardProps(item));
    },
    [clock, cardProps],
  );
  /** Each card's rest before its last Next, so an undo can put the card back on its rung. */
  const restBefore = useRef(new Map<string, Rest | undefined>());
  /** The last decision, so a Next straight after acting on the same card reads as moving on (analytics.ts does the same). */
  const lastDecision = useRef<{ id: string; action: CardAction } | null>(null);
  const decided = useCallback(
    (item: AttentionItem, action: CardAction, via?: CardVia) => {
      const since = shownAt.current.get(idOf(item));
      const props = cardProps(item);
      optsRef.current.capture?.("inbox_card_decided", {
        action,
        ...(via ? { via } : {}),
        ...props,
        dwell_ms: since === undefined ? null : Math.round(clock.now() - since),
      });
      // Next rests the card (rest.ts): a stale one longer each time, one with something new or just replied on, briefly.
      if (action === "next") {
        const prev = optsRef.current.rests?.[keyOf(item.agent_id, item.id)];
        const rest = restAfterNext(item, prev, movesOn(lastDecision.current, idOf(item)));
        restBefore.current.set(idOf(item), prev);
        if (rest) optsRef.current.rest?.(item.agent_id, item.id, rest);
      }
      lastDecision.current = { id: idOf(item), action };
    },
    [clock, cardProps],
  );
  /** A Next or an Archive taken back: the ranking's miss, or a slip. */
  const undone = useCallback((item: AttentionItem, action: "next" | "archive") => {
    optsRef.current.capture?.("inbox_card_undone", { action, desk: deskOf(item.agent_id, item.id), agent: item.agent_id });
    // A Next taken back: the card is back now, on the rung it had.
    if (action === "next") optsRef.current.rest?.(item.agent_id, item.id, restUndone(restBefore.current.get(idOf(item))));
  }, []);
  /** An agent pill chosen in the Inbox (null: All). */
  const filtered = useCallback((agent: string | null) => {
    optsRef.current.capture?.("inbox_filtered", { agent });
  }, []);

  /** Whether a chat's log holds rows older than those loaded: by position when the thread knows its own, else as the page said. */
  const markOlder = useCallback((key: string, more: boolean) => {
    setOlder((o) => (!!o[key] === more ? o : more ? { ...o, [key]: true } : withoutKey(o, key)));
  }, []);

  /**
   * A chat's thread comes from the mod, which reads it from the daemon's store: the newest page, with the older
   * pages already read kept in front of it (plan 033). A paired Mac on an older loki pages by a growing limit
   * instead, and its answer replaces what was loaded.
   */
  const loadThread = useCallback(
    async (rt: Runtime) => {
      const key = keyOf(rt.agent_id, rt.conversation_id);
      if (loading.current.has(key)) return;
      loading.current.add(key);
      const read = async () => {
        const thread = liveOf(key).thread;
        const limit = thread.firstPosition === null ? (historyLimits.current.get(key) ?? HISTORY_PAGE) : HISTORY_PAGE;
        const page = await optsRef.current.loadLocalHistory?.(rt.agent_id, rt.conversation_id, limit);
        // A page that did not come leaves a thread never loaded unloaded, not empty; one already loaded stays as it is.
        const unreached = page === null;
        setFailed((f) => (!!f[key] === (unreached && thread.rows() === undefined) ? f : unreached ? { ...f, [key]: true } : withoutKey(f, key)));
        if (unreached) return;
        const rows: HistoryRow[] = page?.rows ?? [];
        thread.load(rows, page?.start);
        const first = thread.firstPosition;
        markOlder(key, first === null ? !!page?.more : first > 0);
        publish();
      };
      // A promise's catch, not try/finally (the React Compiler takes neither a finally nor a ?? inside a try): the key frees either way.
      await read().catch((err: unknown) => console.warn("loki: thread", err));
      loading.current.delete(key);
    },
    [liveOf, publish, markOlder],
  );
  const loadHistory = useCallback((item: AttentionItem) => loadThread(item.runtime), [loadThread]);
  /**
   * The next page of a chat's history, older than what is loaded: asked for when the reader reaches the top. Only
   * that page travels (plan 033): the rows before the oldest one loaded, put in front of it.
   */
  const loadOlder = useCallback(
    (rt: Runtime) => {
      const key = keyOf(rt.agent_id, rt.conversation_id);
      if (loading.current.has(key)) return;
      const thread = liveOf(key).thread;
      const before = thread.firstPosition;
      if (before === null) {
        historyLimits.current.set(key, (historyLimits.current.get(key) ?? HISTORY_PAGE) + HISTORY_PAGE);
        void loadThread(rt);
        return;
      }
      loading.current.add(key);
      const read = async () => {
        const page = await optsRef.current.loadLocalHistory?.(rt.agent_id, rt.conversation_id, HISTORY_PAGE, before);
        if (page?.start !== undefined) thread.prepend(page.rows, page.start);
        const first = thread.firstPosition;
        markOlder(key, first !== null && first > 0);
        publish();
      };
      void read()
        .catch((err: unknown) => console.warn("loki: older thread", err))
        .then(() => loading.current.delete(key));
    },
    [liveOf, loadThread, publish, markOlder],
  );

  /** A new conversation under an agent, in a folder: the runtime of the desk it becomes. */
  const createDesk = useCallback(
    async (agentId: string, cwd: string, name?: string, home?: string): Promise<Runtime> => {
      const sock = socketRef.current;
      if (!sock) throw new Error("not connected to loki's daemon");
      const rt = await sock.createConversation(agentId, cwd, name, home);
      const agentName = agents.find((a) => a.id === agentId)?.name ?? null;
      setConversations((c) => [
        {
          id: rt.conversation_id,
          agent_id: rt.agent_id,
          agent_name: agentName,
          title: name?.trim() || null,
          last_message_at: new Date().toISOString(),
          archived: false,
        },
        ...c,
      ]);
      return rt;
    },
    [agents],
  );

  /** Subscribe to a conversation that is not among the recent ones (e.g. the desk's). */
  const subscribe = useCallback(async (rt: Runtime) => {
    const sock = socketRef.current;
    if (!sock || sock.isSubscribed(rt)) return;
    try {
      await sock.runtimeStart(rt);
    } catch (err) {
      console.warn("loki: subscribe", err);
    }
  }, []);

  /**
   * A chat surface's view of one conversation besides its rows: the box status, the pending approval or question,
   * mode, folder, engine, and the way to older history. The rows come through useConversation, which redraws on them.
   */
  const conversation = useCallback(
    (agentId: string, conversationId: string): ChatFace => {
      const key = keyOf(agentId, conversationId);
      const l = live.get(key);
      return {
        status: chatStatusOf(l),
        pending: l?.pending ?? null,
        question: l?.pendingAsk ?? null,
        error: l?.error ?? null,
        mode: l?.mode ?? null,
        cwd: l?.cwd ?? null,
        engine: l?.engine ?? null,
        older: older[key] ? () => loadOlder({ agent_id: agentId, conversation_id: conversationId }) : null,
        loadFailed: failed[key] ? () => void loadThread({ agent_id: agentId, conversation_id: conversationId }) : null,
        loadStep: (row) => optsRef.current.loadLocalStep?.(agentId, conversationId, row) ?? Promise.resolve(null),
        suggestions: l?.suggestions ?? NO_SUGGESTIONS,
      };
    },
    [live, older, failed, loadOlder, loadThread],
  );

  const decide = useCallback(
    (rt: Runtime, requestId: string, behavior: "allow" | "deny" | "always") => {
      const l = liveRef.current.get(keyOf(rt.agent_id, rt.conversation_id));
      const was = l?.pending?.requestId === requestId ? l.pending : null;
      if (l && was) l.pending = null; // optimistic: the card clears at once
      optsRef.current.markSeen(rt.agent_id, rt.conversation_id);
      optsRef.current.engage?.(rt.agent_id, rt.conversation_id, "decide");
      optsRef.current.capture?.("approval_decided", {
        desk: deskOf(rt.agent_id, rt.conversation_id),
        agent: rt.agent_id,
        turn_id: l?.turnId ?? null,
        behavior,
        wait_ms: was ? Math.max(0, Date.now() - Date.parse(was.at)) || null : null,
      });
      bump();
      void socketRef.current?.respondApproval(rt, requestId, behavior).then((ok) => {
        if (ok || !l || !was) return;
        l.pending ??= was; // the server refused: put the request back
        bump();
      });
    },
    [bump],
  );
  const approve = useCallback(
    (item: AttentionItem, requestId: string, behavior: "allow" | "deny" | "always") => decide(item.runtime, requestId, behavior),
    [decide],
  );

  /** Answer a pending question card (the user_ask tool); the card clears at once and comes back if the server refuses. */
  const answer = useCallback(
    (rt: Runtime, requestId: string, answers: Record<string, string | string[]>) => {
      const l = liveRef.current.get(keyOf(rt.agent_id, rt.conversation_id));
      const was = l?.pendingAsk?.requestId === requestId ? l.pendingAsk : null;
      if (!l || !was) return;
      l.pendingAsk = null;
      const summary = Object.values(answers)
        .map((a) => (Array.isArray(a) ? a.join(", ") : a))
        .join(" · ");
      if (summary.trim()) l.thread.own({ role: "user", text: summary, at: new Date().toISOString() });
      optsRef.current.markSeen(rt.agent_id, rt.conversation_id);
      optsRef.current.engage?.(rt.agent_id, rt.conversation_id, "answer");
      optsRef.current.capture?.("question_answered", {
        desk: deskOf(rt.agent_id, rt.conversation_id),
        agent: rt.agent_id,
        wait_ms: Math.max(0, Date.now() - Date.parse(was.at)) || null,
      });
      bump();
      void socketRef.current?.answerQuestion(rt, requestId, buildQuestionAnswer(was.input, answers)).then((ok) => {
        if (ok) return;
        l.pendingAsk ??= was;
        bump();
      });
    },
    [bump],
  );

  /**
   * The person's actions on a chat's suggestions (plan 047), carried out by the Mac the chat lives on. The card shows
   * the outcome; the suggestion's new state reaches every client as the chat's `suggestions` event, so nothing here
   * changes the live state itself. A call that does not get through leaves the suggestion as it was, with the reason.
   */
  const suggestions = useMemo(() => {
    const run = async (call: (sock: ChatClient) => Promise<{ suggestion: Suggestion; done: boolean; message: string | null }>): Promise<SuggestionOutcome> => {
      const sock = socketRef.current;
      if (!sock) return { done: false, message: "not connected to loki's daemon", suggestion: null };
      try {
        const out = await call(sock);
        return { done: out.done, message: out.message, suggestion: out.suggestion };
      } catch (err) {
        return { done: false, message: err instanceof Error ? err.message : String(err), suggestion: null };
      }
    };
    return {
      /** Send it now, save it as a draft in its target chat, or reject it. */
      decide: (rt: Runtime, suggestionId: string, action: SuggestionAction) => run((sock) => sock.suggestions.decide(rt, suggestionId, action)),
      /** Point it at another chat, or at a new chat with an agent in a folder, before acting on it (R4). */
      retarget: (rt: Runtime, suggestionId: string, target: SuggestionTarget) => run((sock) => sock.suggestions.retarget(rt, suggestionId, target)),
    };
  }, []);

  /** The chat holds no saved draft any more: its Inbox mark goes without waiting for the list. */
  const noDraft = useCallback((agentId: string, conversationId: string) => {
    setConversations((c) => c.map((x) => (x.agent_id === agentId && x.id === conversationId && x.has_draft ? { ...x, has_draft: false } : x)));
  }, []);
  // The saved drafts follow the list; a box emptied of one clears it on the daemon (chat_update draft null).
  const savedTexts = useMemo(
    () =>
      new Map(
        conversations.flatMap((c): Array<[string, string]> => {
          const text = draftTextOf(c);
          return text ? [[keyOf(c.agent_id, c.id), text]] : [];
        }),
      ),
    [conversations],
  );
  useEffect(() => savedDrafts.replace(savedTexts), [savedTexts]);
  useEffect(
    () =>
      savedDrafts.onEmptied((agentId, conversationId) => {
        noDraft(agentId, conversationId);
        void socketRef.current?.updateConversation(conversationId, { draft: null }).catch((err: unknown) => console.warn("loki: clear saved draft", err));
      }),
    [noDraft],
  );

  /**
   * Send a message into a conversation. Shown at once; the server's echo of it is recognised and not shown twice. During a
   * turn it joins the turn, or on an agent waits for its end (sendMode).
   */
  const send = useCallback(
    (rt: Runtime, text: string, images: Attachment[] = [], env: { desk?: string | null; labels?: readonly string[] | null; origin?: SendOrigin } = {}) => {
      const key = keyOf(rt.agent_id, rt.conversation_id);
      const l = liveOf(key);
      const fileCount = images.filter(isFileAttachment).length;
      optsRef.current.capture?.("message_sent", {
        desk: deskOf(rt.agent_id, rt.conversation_id),
        agent: rt.agent_id,
        turn_id: l.turnId ?? null,
        origin: env.origin ?? null,
        images: images.length - fileCount,
        files: fileCount,
        queued: l.inTurn,
      });
      optsRef.current.sent?.(rt);
      // The chat's next send spends its saved draft (plan 047, KTD7): the box and the Inbox mark lose it now.
      if (savedDrafts.drop(rt.agent_id, rt.conversation_id)) noDraft(rt.agent_id, rt.conversation_id);
      const mode = sendMode(l);
      // Mid-turn on an agent: keep it. The transcript shows it as queued; it leaves when the turn ends (see the event loop).
      if (mode === "queue") {
        l.queued.push({ text, images, desk: env.desk, labels: env.labels });
        l.thread.queue(sentRow(text, images));
        bump();
        return;
      }
      const out = outgoing(text, images);
      l.thread.own(sentRow(text, images), out.key);
      l.lastRole = "user";
      bump();
      void subscribe(rt)
        .then(() => socketRef.current?.sendUserMessage(rt, out.text, out.images, noteFor(envNotes.current, key, env.desk, env.labels), mode === "steer"))
        .catch((err: unknown) => console.warn("loki: send", err));
      optsRef.current.markSeen(rt.agent_id, rt.conversation_id);
    },
    [subscribe, bump, liveOf, noDraft],
  );
  /** Take back a message typed mid-turn before it went out. */
  const cancelQueued = useCallback(
    (rt: Runtime, text: string) => {
      const l = liveRef.current.get(keyOf(rt.agent_id, rt.conversation_id));
      if (l && dropQueued(l, text)) bump();
    },
    [bump],
  );
  const reply = useCallback(
    (item: AttentionItem, text: string, images: Attachment[] = []) =>
      send(item.runtime, text, images, { desk: item.title, labels: item.labels ?? null, origin: "inbox" }),
    [send],
  );

  /**
   * A slash command for the harness (/reload, /compact …): execute_command, the path Desktop uses. The
   * transcript row comes from the harness's slash_command_start / _end deltas when the conversation is
   * subscribed; the answer here fills the row in when those never arrived, or when the call failed.
   */
  const execute = useCallback(
    async (rt: Runtime, commandId: string, args?: string): Promise<{ success: boolean; output: string }> => {
      const l = liveOf(keyOf(rt.agent_id, rt.conversation_id));
      const input = commandInput(commandId, args);
      const now = () => new Date().toISOString();
      optsRef.current.capture?.("command_run", { command: commandId });
      const sock = socketRef.current;
      if (!sock) {
        l.thread.finishCommand(input, false, "not connected to loki's daemon", now());
        bump();
        return { success: false, output: "not connected to loki's daemon" };
      }
      if (!sock.isSubscribed(rt)) l.thread.beginCommand(input, now()); // no deltas will come for this one; show the running row ourselves
      bump();
      try {
        const res = await sock.executeCommand(rt, commandId, args);
        if (l.thread.commandRunning(input)) l.thread.finishCommand(input, res.success, res.output, now());
        bump();
        return res;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        // /reload restarts the mod, and the mod is this link: the answer is lost with it, which is the success case.
        const reloaded = commandId === "reload" && /link closed/i.test(message);
        l.thread.finishCommand(input, reloaded, reloaded ? "reloaded — the mod restarted and the link is back" : message, now());
        bump();
        return { success: reloaded, output: reloaded ? "reloaded" : message };
      }
    },
    [bump, liveOf],
  );

  const updateAgent = useCallback(
    async (agentId: string, body: { name?: string; description?: string; model?: string; home_mac?: string }): Promise<string | null> => {
      const sock = socketRef.current;
      if (!sock) return "not connected to loki's daemon";
      try {
        await sock.updateAgent(agentId, body);
        const name = body.name;
        if (name) setAgents((a) => a.map((x) => (x.id === agentId ? { ...x, name } : x)));
        return null;
      } catch (err) {
        return err instanceof Error ? err.message : String(err);
      }
    },
    [],
  );
  /** The provider catalogue, loaded on demand; null until asked. */
  const [providers, setProviders] = useState<ConnectProvider[] | null>(null);
  /** The catalogue as last loaded, for a failed reload to fall back on (read at call time, so loadProviders stays one function). */
  const providersRef = useRef(providers);
  useEffect(() => {
    providersRef.current = providers;
  });
  const loadProviders = useCallback(async (): Promise<ConnectProvider[]> => {
    const sock = socketRef.current;
    if (!sock) return [];
    try {
      const list = await sock.listConnectProviders();
      setProviders(list);
      return list;
    } catch {
      return providersRef.current ?? [];
    }
  }, []);
  const connectProvider = useCallback(async (providerId: string, fields: Record<string, string>, authMethodId?: string): Promise<string | null> => {
    const sock = socketRef.current;
    if (!sock) return "not connected to loki's daemon";
    try {
      setProviders(await sock.connectProvider(providerId, fields, authMethodId));
      return null;
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
  }, []);
  const disconnectProvider = useCallback(async (providerId: string): Promise<string | null> => {
    const sock = socketRef.current;
    if (!sock) return "not connected to loki's daemon";
    try {
      setProviders(await sock.disconnectProvider(providerId));
      return null;
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
  }, []);
  /** A new agent with its name, description, persona and model, in one request; the agent list reloads. Resolves to the new id. */
  const createAgent = useCallback(async (opts: NewAgentOptions): Promise<{ id: string } | { error: string }> => {
    const sock = socketRef.current;
    if (!sock) return { error: "not connected to loki's daemon" };
    let made: { id: string; name: string };
    try {
      const created = await sock.createAgent(opts);
      made = { id: created.id, name: created.name };
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
    setAgents((a) => (a.some((x) => x.id === made.id) ? a : [...a, made]));
    reloadRef.current?.();
    return { id: made.id };
  }, []);
  const deleteAgent = useCallback(async (agentId: string): Promise<string | null> => {
    const sock = socketRef.current;
    if (!sock) return "not connected to loki's daemon";
    try {
      await sock.deleteAgent(agentId);
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
    setAgents((a) => a.filter((x) => x.id !== agentId));
    reloadRef.current?.();
    return null;
  }, []);
  const memory = useMemo(
    () => ({
      write: async (agentId: string, path: string, content: string, message?: string): Promise<string | null> => {
        const sock = socketRef.current;
        if (!sock) return "not connected to loki's daemon";
        return sock.writeMemoryFile(agentId, path, content, message).then(
          () => null,
          (err: unknown) => (err instanceof Error ? err.message : String(err)),
        );
      },
      remove: async (agentId: string, path: string, message?: string): Promise<string | null> => {
        const sock = socketRef.current;
        if (!sock) return "not connected to loki's daemon";
        return sock.deleteMemoryFile(agentId, path, message).then(
          () => null,
          (err: unknown) => (err instanceof Error ? err.message : String(err)),
        );
      },
      revert: async (agentId: string, sha: string): Promise<string | null> => {
        const sock = socketRef.current;
        if (!sock) return "not connected to loki's daemon";
        return sock.revertMemoryCommit(agentId, sha).then(
          () => null,
          (err: unknown) => (err instanceof Error ? err.message : String(err)),
        );
      },
    }),
    [],
  );
  /**
   * Labels on chats (plan 022): the list every chip takes its colour from, loaded on first use and after each
   * change; `set` gives a chat its labels and `edit` renames, recolours or deletes one everywhere. Each resolves to an
   * error message, or null when it took.
   */
  const [labelList, setLabelList] = useState<LabelView[] | null>(null);
  const labels = useMemo(() => {
    const load = async (): Promise<string | null> => {
      const sock = socketRef.current;
      if (!sock) return "not connected to loki's daemon";
      try {
        setLabelList((await sock.labels.get()).labels);
        return null;
      } catch (err) {
        return err instanceof Error ? err.message : String(err);
      }
    };
    const run = async (work: (sock: ChatClient) => Promise<unknown>): Promise<string | null> => {
      const sock = socketRef.current;
      if (!sock) return "not connected to loki's daemon";
      try {
        await work(sock);
      } catch (err) {
        return err instanceof Error ? err.message : String(err);
      }
      return load();
    };
    return {
      list: labelList,
      load,
      set: (rt: Runtime, next: string[]) => run((s) => s.labels.set(rt, next)),
      edit: (change: Parameters<ChatClient["labels"]["edit"]>[0]) => run((s) => s.labels.edit(change)),
    };
  }, [labelList]);
  // Read once the daemon is there, for every chip on this client; each change reads it again (`run` above).
  const loadLabels = labels.load;
  const labelsOnOpen = useRef(loadLabels);
  useEffect(() => {
    labelsOnOpen.current = loadLabels;
  });
  useEffect(() => {
    if (status === "open") void labelsOnOpen.current();
  }, [status]);
  /** Settings › Engines (plan 020); each resolves to the agents as they now stand, or an error message. */
  const engines = useMemo(() => {
    const via = async <T>(work: (sock: ChatClient) => Promise<T>): Promise<T | string> => {
      const sock = socketRef.current;
      if (!sock) return "not connected to loki's daemon";
      return work(sock).catch((err: unknown) => (err instanceof Error ? err.message : String(err)));
    };
    return {
      get: () => via((s) => s.engines.get()),
      set: (engine: Parameters<ChatClient["engines"]["set"]>[0]) => via((s) => s.engines.set(engine)),
      remove: (id: string) => via((s) => s.engines.remove(id)),
      check: (id: string) => via((s) => s.engines.check(id)),
    };
  }, []);
  /** Settings › MCP, Agents › Profile and Settings › Chat's always-allowed tools; each resolves to its result or an error message. */
  const mcp = useMemo(() => {
    const via = async <T>(work: (sock: ChatClient) => Promise<T>): Promise<T | string> => {
      const sock = socketRef.current;
      if (!sock) return "not connected to loki's daemon";
      return work(sock).catch((err: unknown) => (err instanceof Error ? err.message : String(err)));
    };
    return {
      get: () => via((s) => s.mcp.get()),
      server: (entry: string, edit: Parameters<ChatClient["mcp"]["server"]>[1], rename?: string) => via((s) => s.mcp.server(entry, edit, rename)),
      alwaysLoad: (entry: string, tools: string[]) => via((s) => s.mcp.alwaysLoad(entry, tools)),
      restart: (name: string) => via((s) => s.mcp.restart(name)),
      signOut: (name: string) => via((s) => s.mcp.signOut(name)),
      agent: (agentId: string, server: string, on: boolean) => via((s) => s.mcp.agent(agentId, server, on)),
      // A reference on success, an error message otherwise: never confusable, since one would land in mcp.json.
      secret: (name: string, value: string) => via(async (s) => ({ ref: await s.mcp.secret(name, value) })),
      approvals: {
        list: () => via((s) => s.approvalsAlways()),
        set: (tool: string, on: boolean) => via((s) => s.setApprovalAlways(tool, on)),
      },
    };
  }, []);
  const skills = useMemo(
    () => ({
      enable: async (path: string): Promise<string | null> => {
        const sock = socketRef.current;
        if (!sock) return "not connected to loki's daemon";
        return sock.skillEnable(path).then(
          () => null,
          (err: unknown) => (err instanceof Error ? err.message : String(err)),
        );
      },
      disable: async (name: string): Promise<string | null> => {
        const sock = socketRef.current;
        if (!sock) return "not connected to loki's daemon";
        return sock.skillDisable(name).then(
          () => null,
          (err: unknown) => (err instanceof Error ? err.message : String(err)),
        );
      },
    }),
    [],
  );
  const listModels = useCallback(async () => {
    const sock = socketRef.current;
    if (!sock) return [];
    try {
      return await sock.listModels();
    } catch {
      return [];
    }
  }, []);
  /** Set a conversation's permission mode (runtime_start with `mode`); resolves to an error message or null. */
  /**
   * Move a conversation to another folder; resolves to an error or null once the daemon has answered (a device
   * status with the new folder, or an error), or after FOLDER_MOVE_MS with no answer. The daemon keeps the folder
   * in the chat's settings (its cwd), where the chat's tools run from its next turn.
   */
  const changeFolder = useCallback(async (rt: Runtime, cwd: string): Promise<string | null> => {
    const sock = socketRef.current;
    if (!sock) return "not connected to loki's daemon";
    const to = cwd.trim().replace(/(.)\/+$/, "$1");
    if (!to) return "no folder";
    if (!sock.isSubscribed(rt)) {
      try {
        await sock.runtimeStart(rt); // its device status and errors come to subscribers
      } catch (err) {
        return err instanceof Error ? err.message : String(err);
      }
    }
    const key = keyOf(rt.agent_id, rt.conversation_id);
    const from = liveRef.current.get(key)?.cwd;
    folderMoves.current.get(key)?.done("replaced by a newer change");
    return new Promise<string | null>((resolve) => {
      const timer = setTimeout(() => move.done("the daemon did not answer; the folder may not have changed"), FOLDER_MOVE_MS);
      const move = {
        from,
        to,
        done: (err: string | null) => {
          clearTimeout(timer);
          if (folderMoves.current.get(key) === move) folderMoves.current.delete(key);
          if (!err) optsRef.current.capture?.("folder_changed", { desk: deskOf(rt.agent_id, rt.conversation_id), agent: rt.agent_id });
          resolve(err);
        },
      };
      folderMoves.current.set(key, move);
      sock.changeFolder(rt, to).catch((err: unknown) => move.done(err instanceof Error ? err.message : String(err)));
    });
  }, []);

  const setMode = useCallback(
    async (rt: Runtime, mode: string): Promise<string | null> => {
      const sock = socketRef.current;
      if (!sock) return "not connected to loki's daemon";
      try {
        await sock.runtimeStart(rt, { mode });
      } catch (err) {
        return err instanceof Error ? err.message : String(err);
      }
      const l = liveRef.current.get(keyOf(rt.agent_id, rt.conversation_id));
      if (l) l.mode = mode;
      optsRef.current.capture?.("mode_set", { mode });
      bump();
      return null;
    },
    [bump],
  );
  /**
   * Archive or restore a conversation; resolves to an error message or null. Main chats cannot be archived.
   * Archiving is how a chat leaves the Inbox, so it goes from the list at once; a restore reads the list again.
   */
  const archiveConversation = useCallback(async (conversationId: string, archived: boolean, origin?: ArchiveOrigin): Promise<string | null> => {
    const sock = socketRef.current;
    if (!sock) return "not connected to loki's daemon";
    if (conversationId === "default") return "a main chat cannot be archived";
    try {
      await sock.updateConversation(conversationId, { archived });
      if (origin)
        optsRef.current.capture?.(archived ? "chat_archived" : "chat_restored", {
          desk: scopeFor(conversationId),
          origin,
          ...(archived ? { turn_id: [...liveRef.current].find(([key]) => key.endsWith(`/${conversationId}`))?.[1].turnId ?? null } : {}),
        });
      if (archived) setConversations((c) => c.filter((x) => x.id !== conversationId));
      else reloadRef.current?.();
      return null;
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
  }, []);
  /** Rename a conversation (a desk); resolves to an error message or null. Main chats are named after their agent and cannot be renamed. */
  const renameConversation = useCallback(async (conversationId: string, name: string): Promise<string | null> => {
    const sock = socketRef.current;
    if (!sock) return "not connected to loki's daemon";
    if (conversationId === "default") return "a main chat cannot be renamed";
    try {
      await sock.renameConversation(conversationId, name);
      return null;
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
  }, []);
  /**
   * Give a chat its one-line purpose (plan 047, R11), or clear it with an empty one; resolves to an error message or
   * null. The Inbox list has it at once, so the header shows it before the list is read again.
   */
  const setPurpose = useCallback(async (rt: Runtime, purpose: string): Promise<string | null> => {
    const sock = socketRef.current;
    if (!sock) return "not connected to loki's daemon";
    const line = purpose.replace(/\s+/g, " ").trim() || null;
    try {
      await sock.updateConversation(rt.conversation_id, { purpose: line });
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
    setConversations((c) => c.map((x) => (x.agent_id === rt.agent_id && x.id === rt.conversation_id ? { ...x, purpose: line } : x)));
    return null;
  }, []);
  /** Stop a conversation's turn (the composer's stop button); resolves to an error message or null. */
  const stop = useCallback(async (rt: Runtime): Promise<string | null> => {
    const sock = socketRef.current;
    if (!sock) return "not connected to loki's daemon";
    try {
      const turnId = liveRef.current.get(keyOf(rt.agent_id, rt.conversation_id))?.turnId ?? null;
      const aborted = await sock.abortTurn(rt);
      optsRef.current.capture?.("turn_stopped", { aborted, turn_id: turnId });
      return null;
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
  }, []);
  /** Switch a conversation's model; returns the applied handle/effort or an error. */
  const updateModel = useCallback(async (rt: Runtime, selection: ModelSelection): Promise<{ applied: AppliedModel | null; error: string | null }> => {
    const sock = socketRef.current;
    if (!sock) return { applied: null, error: "not connected to loki's daemon" };
    let applied: AppliedModel;
    try {
      applied = await sock.updateModel(rt, selection);
    } catch (err) {
      return { applied: null, error: err instanceof Error ? err.message : String(err) };
    }
    optsRef.current.capture?.("model_switched", { model: applied.handle, effort: applied.reasoning_effort });
    return { applied, error: null };
  }, []);

  /**
   * The background passes (daemon/passes.ts): whether reflection and Learn run, and a reflection pass started by hand
   * — the same as /reflect in that conversation's chat.
   */
  const reflection = useMemo(
    () => ({
      get: async (): Promise<PassSettings | null> => {
        const sock = socketRef.current;
        if (!sock) return null;
        try {
          return await sock.getPassSettings();
        } catch {
          return null;
        }
      },
      set: async (s: { reflection?: { enabled: boolean }; learn?: { enabled?: boolean; daily_cap?: number } }): Promise<string | null> => {
        const sock = socketRef.current;
        if (!sock) return "not connected to loki's daemon";
        try {
          await sock.setPassSettings(s);
          return null;
        } catch (err) {
          return err instanceof Error ? err.message : String(err);
        }
      },
      run: async (rt: Runtime): Promise<string> => {
        const sock = socketRef.current;
        if (!sock) return "not connected to loki's daemon";
        let r: { success: boolean; output: string };
        try {
          r = await sock.executeCommand(rt, "reflect");
        } catch (err) {
          return err instanceof Error ? err.message : String(err);
        }
        return r.output || (r.success ? "started" : "the harness refused");
      },
    }),
    [],
  );

  const markDone = useCallback((item: AttentionItem) => optsRef.current.markSeen(item.agent_id, item.id), []);
  const markNotDone = useCallback((item: AttentionItem) => optsRef.current.unmarkSeen(item.agent_id, item.id), []);
  /** Done with a chat: it is archived and leaves the Inbox; resolves to an error or null. */
  const archive = useCallback((item: AttentionItem) => archiveConversation(item.id, true, "inbox"), [archiveConversation]);
  /** Undo of an archive: the chat comes back. */
  const unarchive = useCallback((item: AttentionItem) => archiveConversation(item.id, false, "inbox_undo"), [archiveConversation]);

  // One object while its parts hold (the compiler memoises it): the shell and the phone re-render on a change, not on every render.
  return {
    status,
    server,
    /** Every slash command the box offers: loki's, the harness's, and whatever else this harness advertised. */
    commands: useMemo(() => allCommands(server?.advertised, server?.only), [server?.advertised, server?.only]),
    execute,
    agents,
    agentsLoaded,
    /** The chat list has come at least once: a chat missing from `items` after this is archived or gone. */
    listed,
    providers,
    loadProviders,
    connectProvider,
    disconnectProvider,
    createAgent,
    deleteAgent,
    memory,
    mcp,
    engines,
    labels,
    skills,
    updateAgent,
    reflection,
    listModels,
    updateModel,
    stop,
    setMode,
    changeFolder,
    archiveConversation,
    renameConversation,
    setPurpose,
    createDesk,
    items,
    loadHistory,
    loadThread,
    subscribe,
    conversation,
    watchThreads,
    threadRows,
    approve,
    decide,
    answer,
    suggestions,
    reply,
    send,
    cancelQueued,
    reload,
    seen: markDone,
    unread: markNotDone,
    archive,
    unarchive,
    /** Log an Inbox decision (the deck calls it; the same actions elsewhere are not Inbox decisions). */
    decided,
    shown,
    undone,
    filtered,
  };
}
