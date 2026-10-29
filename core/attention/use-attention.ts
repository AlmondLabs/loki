import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { WholeRow } from "./transcript.ts";
import type { Runtime } from "./protocol.ts";
import type { ChatClient } from "./chat-client.ts";
import type { ChatEngineView } from "../models.ts";
import {
  buildItems,
  chatStatusOf,
  keyOf,
  type AttentionItem,
  type ConversationInfo,
  type Digest,
  type PendingApproval,
  type PendingQuestion,
} from "./model.ts";
import type { Attachment } from "./content.ts";
import type { TranscriptRow } from "./transcript.ts";
import { idOf, inboxQueue } from "./queue.ts";
import { createActiveClock, type Activity } from "./active-clock.ts";
import { focusShares, type FocusEntry } from "./focus.ts";
import { movesOn, restAfterNext, restUndone, type Rest } from "./rest.ts";
import { allCommands } from "./commands.ts";
import type { PayloadOf } from "../frames.ts";
import type { Suggestion } from "../frame-types.ts";
import { ChatStore, type ChatStoreHost } from "./chat-store.ts";
import { Listeners } from "../listeners.ts";
import { scopeFor } from "../desk-core.ts";

/** An engagement only the app sees (core/frames.ts focus_add): the mod counts messages and opens itself. */
export type EngageAction = PayloadOf<"focus_add">["action"];

/** What you did with an Inbox card: moved on, archived it (done), decided an approval, replied, or answered its question. */
export type CardAction = "next" | "archive" | "approve" | "deny" | "reply" | "answer" | "open";

/** How a card was acted on: a key or a click on the Mac, a swipe or a tap on the phone. */
export type CardVia = "key" | "click" | "swipe" | "tap";

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
  loadLocalHistory?: ChatStoreHost["loadLocalHistory"];
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
  /**
   * Reports the page shown or hidden (app/src/shared/page-activity.ts), as `activity` does for in front: while hidden the
   * clock tick and the list poll stop (plan 047), since nothing on screen needs them and coming back reloads the lists.
   */
  visibility?: Activity;
  /** The chat client for loki's daemon, over the mod's frames (core/attention/chat-client.ts). */
  makeClient: () => ChatClient;
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
  /** The suggestions made in this chat that wait on the person or are being sent (plan 049), for its chat screen. */
  suggestions: Suggestion[];
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

/** The saved draft's text on an Inbox row (plan 049, KTD7), which the mod sends as `draft_text`; null when it has none. */
function draftTextOf(c: ConversationInfo): string | null {
  return (c.has_draft === true && c.draft_text) || null;
}

/**
 * The suggestions saved as drafts, by chat (plan 049, KTD7): the text each chat's message box shows while nothing is
 * typed in it, as the Inbox list last had it. useAttention keeps it; the app's message-box drafts read it beneath
 * what is typed (app/src/shared/drafts.ts) and say when a box that held one was emptied. Typing never reaches it.
 */
export function createSavedDrafts() {
  let texts = new Map<string, string>();
  const subs = new Listeners();
  let emptiedOnDaemon: (agentId: string, conversationId: string) => void = () => {};
  const emit = () => subs.emit();
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
      return subs.add(fn);
    },
  };
}
/** A saved-drafts registry, as `createSavedDrafts` returns it. */
export type SavedDrafts = ReturnType<typeof createSavedDrafts>;

/** The client's saved drafts: one useAttention runs per page, the shell's or the phone's. */
export const savedDrafts = createSavedDrafts();

/** No suggestions: one array, so a chat's face stays the same while it has none. */
const NO_SUGGESTIONS: Suggestion[] = [];

/**
 * The Inbox's state and actions for a client, the Mac app or the phone. The chats themselves are a ChatStore's
 * (core/attention/chat-store.ts): the list and digests from the mod, the live half from the daemon, the calls that
 * send, decide, archive and manage agents. This hook connects it while the mod's socket is up, scores the items
 * against the seen markers, focus and rests, and keeps the Inbox's own analytics.
 */
export function useAttention(opts: UseAttentionOptions) {
  /**
   * The latest options, for the store and the actions below. The host builds `opts` afresh on every render, so an
   * action that closed over it would be new each time too; read at call time instead, the actions stay the same.
   */
  const optsRef = useRef(opts);
  const [store] = useState(() => new ChatStore(opts));
  useEffect(() => {
    optsRef.current = opts;
    store.setHost(opts);
  });
  const snap = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const { live, older, failed } = snap;

  // Connect while the mod's socket is up; the pending flush has nothing to draw into once the hook is gone.
  useEffect(() => (opts.enabled ? store.connect(optsRef.current.makeClient()) : undefined), [opts.enabled, store]);
  useEffect(() => () => store.dispose(), [store]);

  // The clock tick: focus fades and cards age without any other event, so the items are rebuilt twice a minute.
  // Nothing on screen ages while the page is hidden, so the tick redraws nothing then; back in view, it catches up at once (plan 047).
  const [now, setNow] = useState(() => Date.now());
  const visibleRef = useRef(true);
  const visibility = opts.visibility;
  useEffect(
    () =>
      visibility?.((shown) => {
        if (shown && !visibleRef.current) setNow(Date.now());
        visibleRef.current = shown;
        store.setVisible(shown);
      }),
    [visibility, store],
  );
  useEffect(() => {
    const t = setInterval(() => {
      if (visibleRef.current) setNow(Date.now());
    }, 30_000);
    return () => clearInterval(t);
  }, []);
  const items = useMemo(
    () => buildItems(snap.conversations, snap.digests, live, opts.seen, now, opts.viewed, focusShares(opts.focus ?? {}, now), opts.rests),
    [snap.conversations, snap.digests, opts.seen, opts.viewed, opts.focus, opts.rests, live, now],
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
  const cardProps = useCallback(
    (item: AttentionItem) => {
      const queue = inboxQueue(itemsRef.current);
      const at = queue.findIndex((i) => idOf(i) === idOf(item));
      const it = queue[at] ?? item;
      return {
        desk: deskOf(item.agent_id, item.id),
        agent: item.agent_id,
        turn_id: store.turnOf(item.agent_id, item.id),
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
    [store],
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

  /**
   * A chat surface's view of one conversation besides its rows: the box status, the pending approval or question,
   * mode, folder, engine, and the way to older history. The rows come through useConversation, which redraws on them.
   */
  const conversation = useCallback(
    (agentId: string, conversationId: string): ChatFace => {
      const key = keyOf(agentId, conversationId);
      const l = live.get(key);
      const rt: Runtime = { agent_id: agentId, conversation_id: conversationId };
      return {
        status: chatStatusOf(l),
        pending: l?.pending ?? null,
        question: l?.pendingAsk ?? null,
        error: l?.error ?? null,
        mode: l?.mode ?? null,
        cwd: l?.cwd ?? null,
        engine: l?.engine ?? null,
        older: older[key] ? () => store.loadOlder(rt) : null,
        loadFailed: failed[key] ? () => void store.loadThread(rt) : null,
        loadStep: (row) => optsRef.current.loadLocalStep?.(agentId, conversationId, row) ?? Promise.resolve(null),
        suggestions: l?.suggestions ?? NO_SUGGESTIONS,
      };
    },
    [live, older, failed, store],
  );

  /** Labels on chats (plan 022): the list every chip takes its colour from, and the calls that change them. */
  const labelList = snap.labels;
  const labels = useMemo(() => ({ list: labelList, load: store.loadLabels, set: store.setLabels, edit: store.editLabel }), [labelList, store]);
  /** The background passes (daemon/passes.ts): whether reflection and Learn run, and a reflection pass by hand. */
  const reflection = useMemo(() => ({ get: store.getPasses, set: store.setPasses, run: store.reflect }), [store]);
  /** The person's actions on a chat's suggestions (plan 049), carried out by the Mac the chat lives on. */
  const suggestions = useMemo(() => ({ decide: store.decideSuggestion, retarget: store.retargetSuggestion }), [store]);
  // The saved drafts follow the list; a box emptied of one clears it on the daemon (chat_update draft null).
  const conversations = snap.conversations;
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
  useEffect(() => savedDrafts.onEmptied(store.clearDraft), [store]);
  /**
   * Send a message into a conversation (ChatStore.send). The chat's next send spends its saved draft (plan 049, KTD7):
   * the box and the Inbox mark lose it now.
   */
  const send = useCallback(
    (rt: Runtime, text: string, images?: Attachment[], env?: Parameters<ChatStore["send"]>[3]) => {
      if (savedDrafts.drop(rt.agent_id, rt.conversation_id)) store.noDraft(rt.agent_id, rt.conversation_id);
      store.send(rt, text, images, env);
    },
    [store],
  );
  const approve = useCallback(
    (item: AttentionItem, requestId: string, behavior: "allow" | "deny" | "always") => store.decide(item.runtime, requestId, behavior),
    [store],
  );
  const reply = useCallback(
    (item: AttentionItem, text: string, images: Attachment[] = []) =>
      send(item.runtime, text, images, { desk: item.title, labels: item.labels ?? null, origin: "inbox" }),
    [send],
  );
  const loadHistory = useCallback((item: AttentionItem) => store.loadThread(item.runtime), [store]);
  const markDone = useCallback((item: AttentionItem) => optsRef.current.markSeen(item.agent_id, item.id), []);
  const markNotDone = useCallback((item: AttentionItem) => optsRef.current.unmarkSeen(item.agent_id, item.id), []);
  /** Done with a chat: it is archived and leaves the Inbox; resolves to an error or null. */
  const archive = useCallback((item: AttentionItem) => store.archiveConversation(item.id, true, "inbox"), [store]);
  /** Undo of an archive: the chat comes back. */
  const unarchive = useCallback((item: AttentionItem) => store.archiveConversation(item.id, false, "inbox_undo"), [store]);
  const server = snap.server;

  // One object while its parts hold (the compiler memoises it): the shell and the phone re-render on a change, not on every render.
  return {
    status: snap.status,
    server,
    /** Every slash command the box offers: loki's, the harness's, and whatever else this harness advertised. */
    commands: useMemo(() => allCommands(server?.advertised, server?.only), [server?.advertised, server?.only]),
    execute: store.execute,
    agents: snap.agents,
    agentsLoaded: snap.agentsLoaded,
    /** The chat list has come at least once: a chat missing from `items` after this is archived or gone. */
    listed: snap.listed,
    providers: snap.providers,
    loadProviders: store.loadProviders,
    connectProvider: store.connectProvider,
    disconnectProvider: store.disconnectProvider,
    createAgent: store.createAgent,
    deleteAgent: store.deleteAgent,
    labels,
    updateAgent: store.updateAgent,
    reflection,
    listModels: store.listModels,
    updateModel: store.updateModel,
    stop: store.abortTurn,
    setMode: store.setMode,
    changeFolder: store.changeFolder,
    archiveConversation: store.archiveConversation,
    renameConversation: store.renameConversation,
    setPurpose: store.setPurpose,
    createDesk: store.createDesk,
    items,
    loadHistory,
    loadThread: store.loadThread,
    subscribe: store.follow,
    conversation,
    watchThreads: store.watchThreads,
    threadRows: store.threadRows,
    approve,
    decide: store.decide,
    answer: store.answer,
    suggestions,
    reply,
    send,
    cancelQueued: store.cancelQueued,
    reload: store.reload,
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
