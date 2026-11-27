import type { ChatLink } from "../chat-links.ts";
import type { SubagentView } from "../subagents.ts";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { WholeRow } from "./transcript.ts";
import type { Runtime } from "./protocol.ts";
import type { ChatClient } from "./chat-client.ts";
import type { ChatEngineView } from "../models.ts";
import {
  buildItems,
  chatStatusOf,
  keyOf,
  senderKeyOf,
  type AttentionItem,
  type ConversationInfo,
  type Digest,
  type PendingApproval,
  type PendingQuestion,
} from "./model.ts";
import type { Attachment } from "./content.ts";
import type { TranscriptRow } from "./transcript.ts";
import { idOf } from "./queue.ts";
import { createActiveClock, type Activity } from "./active-clock.ts";
import { focusShares, type FocusEntry } from "./focus.ts";
import {
  RETURN_TIMES_DEFAULT,
  cardKindOf,
  laterMs,
  movesOn,
  readFirstMs,
  restAfterLater,
  restAfterNext,
  restUndone,
  type Rest,
  type ReturnTimes,
} from "./rest.ts";
import { allCommands } from "./commands.ts";
import type { PayloadOf } from "../frames.ts";
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
  OutsideWindowAsk,
  ReplyProposal,
  ReplyThen,
  Suggestion,
} from "../frame-types.ts";
import { ChatStore, type AgentEntry, type ChatStoreHost } from "./chat-store.ts";
import { laneItems, type Lane, type LaneSwitchBy, type ResolvedLane } from "./lanes.ts";
import type { SentReplies } from "./sent-replies.ts";
import { Listeners } from "../listeners.ts";

export type EngageAction = PayloadOf<"focus_add">["action"];

export type CardAction = "next" | "later" | "archive" | "label" | "approve" | "deny" | "reply" | "answer" | "open" | "handoff";

export type CardVia = "key" | "click" | "swipe" | "tap";

export interface LaneChoice {
  id: string;
  setId: (id: string) => void;
  lanes: Lane[] | null;
  setLanes: ((lanes: Lane[]) => void) | null;
  resolve: (lanes: Lane[] | null, items: AttentionItem[], agents: AgentEntry[], id: string) => ResolvedLane | null;
}

export interface FlowLane {
  lane: ResolvedLane | null;
  laneId: string;
  setLaneId: (id: string, by?: LaneSwitchBy) => void;
  lanes: Lane[] | null;
  setLanes: ((lanes: Lane[]) => void) | null;
  laneItems: AttentionItem[];
}

const noLaneSwitch = () => {};

export interface UseAttentionOptions {
  enabled: boolean;
  seen: Record<string, string>;
  viewed?: Record<string, string>;
  focus?: Record<string, FocusEntry>;
  engage?: (agentId: string, conversationId: string, action: EngageAction) => void;
  rests?: Record<string, Rest>;
  rest?: (agentId: string, conversationId: string, rest: Rest) => void;
  returnTimes?: ReturnTimes;
  markSeen: (agentId: string, conversationId: string) => void;
  unmarkSeen: (agentId: string, conversationId: string) => void;
  loadLocalHistory?: ChatStoreHost["loadLocalHistory"];
  loadLocalStep?: (agentId: string, conversationId: string, row: number) => Promise<WholeRow | null>;
  listConversations: () => Promise<Array<ConversationInfo & Digest> | null>;
  subscribeLimit?: number;
  sent?: (rt: Runtime) => void;
  activity?: Activity;
  visibility?: Activity;
  makeClient: () => ChatClient;
  lane?: LaneChoice;
}

export interface ChatFace {
  status: "idle" | "thinking" | "streaming";
  pending: PendingApproval | null;
  question: PendingQuestion | null;
  error: string | null;
  mode: string | null;
  cwd: string | null;
  engine: ChatEngineView | null;
  older: (() => void) | null;
  loadFailed: (() => void) | null;
  loadStep: (row: number) => Promise<WholeRow | null>;
  suggestions: Suggestion[];
  replyProposals?: ReplyProposal[];
  links: ChatLink[];
  subagents?: SubagentView[];
}

export interface ChatView extends ChatFace {
  rows: TranscriptRow[] | undefined;
}

export interface ChatViews {
  conversation: (agentId: string, conversationId: string) => ChatFace;
  watchThreads: (onChange: () => void) => () => void;
  watchThread?: (agentId: string, conversationId: string, onChange: () => void) => () => void;
  threadRows: (agentId: string, conversationId: string) => TranscriptRow[] | undefined;
}

export interface HandoffSource {
  handoffPropose: (item: AttentionItem) => Promise<HandoffProposal | string>;
  handoff: (item: AttentionItem, conversationId: string | null) => Promise<string | null>;
}

export interface OutsideSource {
  readOutside: (item: AttentionItem, ask?: OutsideWindowAsk) => Promise<OutsideRead | string>;
  replyOutside: (item: AttentionItem, text: string, then: ReplyThen, extra?: OutsideReplyExtra) => Promise<OutsideReplyResult>;
  composeOutside?: (item: AttentionItem) => Promise<MailCompose | string>;
  unsendOutside?: (item: AttentionItem, outboxId: string) => Promise<boolean>;
  settleUnsent?: (item: AttentionItem, outboxId: string, action: "resend" | "discard") => Promise<string | null>;
  sentReplies?: SentReplies;
  reactOutside?: (item: AttentionItem, messageId: string, name: string, on: boolean) => Promise<string | null>;
  searchEmoji?: (item: AttentionItem, query: string) => Promise<EmojiChoice[] | string>;
  searchPeople?: (item: AttentionItem, query: string) => Promise<SlackPerson[] | string>;
  pickPerson?: (item: AttentionItem, person: SlackPerson) => void;
}

export interface OutsideReplyExtra {
  mail?: MailAddressing | null;
  outbox_id?: string | null;
  thread_ts?: string | null;
}

export interface OutsideReplyResult {
  sent: boolean;
  error: string | null;
  undone?: true;
}

export interface MoveResult {
  error: string | null;
  ask: boolean;
  rest: Rest | null;
}

export type MoveFacts = Pick<OutsideMove, "return_at" | "labels" | "picked" | "after_reply">;

export function ledgerMoveOf(action: CardAction | "undo", via: CardVia | null, dwellMs: number | null, facts: MoveFacts = {}): OutsideMove | null {
  if (action === "approve" || action === "deny" || action === "answer" || action === "open") return null;
  return { action: action === "next" ? "read" : action, via, dwell_ms: dwellMs, ...facts };
}

export interface CardMovesHost {
  store: Pick<ChatStore, "markReadOutside" | "markUnreadOutside" | "archiveOutside" | "labelOutside" | "restoreOutside" | "archiveConversation">;
  rests: () => Record<string, Rest> | undefined;
  rest: (agentId: string, conversationId: string, rest: Rest) => void;
  markSeen: (agentId: string, conversationId: string) => void;
  unmarkSeen: (agentId: string, conversationId: string) => void;
  returnTimes: () => ReturnTimes | undefined;
  now: () => number;
  report: (item: AttentionItem, action: CardAction, via?: CardVia, facts?: MoveFacts) => void;
  reportUndone: (item: AttentionItem, action: CardAction) => void;
}

interface MoveTaken {
  action: CardAction;
  rested: boolean;
  prev: Rest | undefined;
  change: OutsideChange | null;
  seen: "mark" | "unmark" | null;
}

interface MoveEntry {
  done: Promise<MoveTaken | null>;
  move: MoveTaken | null | undefined;
}

export function createCardMoves(first: CardMovesHost) {
  let host = first;
  const setHost = (next: CardMovesHost): void => {
    host = next;
  };
  const taken = new Map<string, MoveEntry[]>();
  let last: { id: string; action: CardAction } | null = null;
  const times = () => host.returnTimes() ?? RETURN_TIMES_DEFAULT;
  const prevOf = (item: AttentionItem) => host.rests()?.[keyOf(item.agent_id, item.id)];
  const note = (item: AttentionItem, action: CardAction, via?: CardVia, facts?: MoveFacts) => {
    host.report(item, action, via, facts);
    last = { id: idOf(item), action };
  };
  const stackOf = (item: AttentionItem): MoveEntry[] => {
    const id = idOf(item);
    const stack = taken.get(id) ?? [];
    taken.set(id, stack);
    return stack;
  };
  const begin = (item: AttentionItem) => {
    let resolve: (move: MoveTaken | null) => void = () => {};
    const entry: MoveEntry = { done: new Promise((r) => (resolve = r)), move: undefined };
    stackOf(item).push(entry);
    return (move: (Partial<MoveTaken> & { action: CardAction }) | null): void => {
      if (entry.move !== undefined) return;
      entry.move = move && { rested: false, prev: undefined, change: null, seen: null, ...move };
      if (!entry.move) {
        const stack = stackOf(item);
        const at = stack.indexOf(entry);
        if (at >= 0) stack.splice(at, 1);
      }
      resolve(entry.move);
    };
  };
  const keep = (item: AttentionItem, move: Partial<MoveTaken> & { action: CardAction }) => begin(item)(move);
  const rest = (item: AttentionItem, r: Rest | null) => {
    if (r) host.rest(item.agent_id, item.id, r);
    return r;
  };
  const readRest = (item: AttentionItem, movedOn: boolean) => restAfterNext(item, prevOf(item), movedOn, host.now(), readFirstMs(times(), cardKindOf(item)));
  const laterRest = (item: AttentionItem) => restAfterLater(item, prevOf(item), host.now(), laterMs(times(), cardKindOf(item)));

  const read = async (item: AttentionItem, via?: CardVia): Promise<MoveResult> => {
    const movedOn = movesOn(last, idOf(item));
    const prev = prevOf(item);
    const settle = begin(item);
    try {
      let change: OutsideChange | null = null;
      if (item.outside) {
        const w = await host.store.markReadOutside(item);
        if (w.error) return { error: w.error, ask: false, rest: null };
        change = w.change;
      }
      host.markSeen(item.agent_id, item.id);
      const r = rest(item, change?.ended ? null : readRest(item, movedOn));
      settle({ action: "next", rested: !!r, prev, change, seen: item.unread ? "unmark" : null });
      note(item, "next", via, { return_at: r?.until ?? null });
      return { error: null, ask: false, rest: r };
    } finally {
      settle(null);
    }
  };

  const laterAsks = (item: AttentionItem): boolean => laterRest(item)?.ask ?? false;

  const later = async (item: AttentionItem, via?: CardVia, until?: string): Promise<MoveResult> => {
    const next = laterRest(item);
    if (!next) {
      keep(item, { action: "later" });
      note(item, "later", via);
      return { error: null, ask: false, rest: null };
    }
    if (next.ask && until === undefined) return { error: null, ask: true, rest: null };
    const prev = prevOf(item);
    const settle = begin(item);
    try {
      let change: OutsideChange | null = null;
      if (item.outside) {
        const w = await host.store.markUnreadOutside(item);
        if (w.error) return { error: w.error, ask: false, rest: null };
        change = w.change;
      }
      if (!item.unread) host.unmarkSeen(item.agent_id, item.id);
      const r = rest(item, until === undefined ? next.rest : { ...next.rest, until });
      settle({ action: "later", rested: true, prev, change, seen: item.unread ? null : "mark" });
      note(item, "later", via, { return_at: r?.until ?? null, picked: until !== undefined });
      return { error: null, ask: false, rest: r };
    } finally {
      settle(null);
    }
  };

  const archive = async (item: AttentionItem, via?: CardVia): Promise<string | null> => {
    const settle = begin(item);
    try {
      if (item.outside) {
        const w = await host.store.archiveOutside(item);
        if (w.error) return w.error;
        settle({ action: "archive", change: w.change });
      } else {
        const err = await host.store.archiveConversation(item.id, true, "flow", item.agent_id);
        if (err) return err;
        settle({ action: "archive" });
      }
      note(item, "archive", via);
      return null;
    } finally {
      settle(null);
    }
  };

  const label = async (item: AttentionItem, labels: string[], via?: CardVia): Promise<string | null> => {
    if (!item.outside) return "only an email card takes labels";
    const settle = begin(item);
    try {
      const w = await host.store.labelOutside(item, labels);
      if (w.error) return w.error;
      settle({ action: "label", change: w.change });
      note(item, "label", via, { labels });
      return null;
    } finally {
      settle(null);
    }
  };

  const replied = (item: AttentionItem, then: ReplyThen, change: OutsideChange | null): void => {
    if (then === "stay") return;
    const prev = prevOf(item);
    let r: Rest | null = null;
    if (then === "archive") keep(item, { action: "archive", change });
    else if (then === "read") {
      host.markSeen(item.agent_id, item.id);
      r = rest(item, change?.ended ? null : readRest(item, true));
      keep(item, { action: "next", rested: !!r, prev, change, seen: item.unread ? "unmark" : null });
    } else {
      if (!item.unread) host.unmarkSeen(item.agent_id, item.id);
      r = rest(item, laterRest(item)?.rest ?? null);
      keep(item, { action: "later", rested: !!r, prev, change, seen: item.unread ? null : "mark" });
    }
    note(item, "reply", undefined, { after_reply: then, return_at: r?.until ?? null });
  };

  const handedOff = (item: AttentionItem): void => {
    keep(item, { action: "handoff" });
    note(item, "handoff");
  };

  const writeBack = (item: AttentionItem, move: MoveTaken): Promise<string | null> => {
    if (move.change) return host.store.restoreOutside(item, move.change);
    if (move.action === "archive" && !item.outside) return host.store.archiveConversation(item.id, false, "flow_undo", item.agent_id);
    return Promise.resolve(null);
  };

  const undo = async (item: AttentionItem): Promise<string | null> => {
    const stack = stackOf(item);
    const entry = stack.at(-1);
    if (!entry) return null;
    if (entry.move?.action === "handoff") return "handed off";
    stack.pop();
    const move = await entry.done;
    if (!move) return null;
    const err = await writeBack(item, move);
    if (err) {
      stackOf(item).push(entry);
      return err;
    }
    if (move.rested) host.rest(item.agent_id, item.id, restUndone(move.prev, host.now()));
    if (move.seen === "mark") host.markSeen(item.agent_id, item.id);
    else if (move.seen === "unmark") host.unmarkSeen(item.agent_id, item.id);
    host.reportUndone(item, move.action);
    return null;
  };

  const decided = (item: AttentionItem, action: CardAction, via?: CardVia): void => {
    if (action === "next") {
      const prev = prevOf(item);
      const r = rest(item, readRest(item, movesOn(last, idOf(item))));
      keep(item, { action: "next", rested: !!r, prev });
    }
    note(item, action, via);
  };

  const undone = (item: AttentionItem, action: "next" | "archive"): void => {
    const stack = stackOf(item);
    const move = stack.at(-1)?.move;
    if (action === "next") host.rest(item.agent_id, item.id, restUndone(move?.action === "next" ? move.prev : undefined, host.now()));
    if (move?.action === action) stack.pop();
    host.reportUndone(item, action);
  };

  return { read, later, laterAsks, archive, label, replied, handedOff, undo, decided, undone, setHost };
}

function movesHost(store: ChatStore, opts: UseAttentionOptions, report: CardMovesHost["report"]): CardMovesHost {
  return {
    store,
    rests: () => opts.rests,
    rest: (agentId, conversationId, rest) => opts.rest?.(agentId, conversationId, rest),
    markSeen: opts.markSeen,
    unmarkSeen: opts.unmarkSeen,
    returnTimes: () => opts.returnTimes,
    now: Date.now,
    report,
    reportUndone: (item) => {
      const move = item.outside ? ledgerMoveOf("undo", null, null) : null;
      if (move) store.moveOutside(item, move);
    },
  };
}

export type CardMoves = ReturnType<typeof createCardMoves>;

export function useConversation(chats: ChatViews, agentId: string, conversationId: string): ChatView;
export function useConversation(chats: ChatViews, agentId: string | null, conversationId: string | null): ChatView | null;
export function useConversation(chats: ChatViews, agentId: string | null, conversationId: string | null): ChatView | null {
  const rows = useThreadRows(chats, agentId, conversationId);
  if (!agentId || !conversationId) return null;
  return { ...chats.conversation(agentId, conversationId), rows };
}

export function useThreadRows(
  chats: Pick<ChatViews, "watchThreads" | "threadRows" | "watchThread">,
  agentId: string | null,
  conversationId: string | null,
): TranscriptRow[] | undefined {
  const subscribe = useCallback(
    (onChange: () => void) =>
      chats.watchThread && agentId && conversationId ? chats.watchThread(agentId, conversationId, onChange) : chats.watchThreads(onChange),
    [chats, agentId, conversationId],
  );
  const read = () => (agentId && conversationId ? chats.threadRows(agentId, conversationId) : undefined);
  return useSyncExternalStore(subscribe, read, read);
}

function draftTextOf(c: ConversationInfo): string | null {
  return (c.has_draft === true && c.draft_text) || null;
}

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
    text: (agentId: string, conversationId: string): string | null => texts.get(keyOf(agentId, conversationId)) ?? null,
    replace(next: ReadonlyMap<string, string>) {
      if (next.size === texts.size && [...next].every(([k, t]) => texts.get(k) === t)) return;
      texts = new Map(next);
      emit();
    },
    drop,
    emptied(agentId: string, conversationId: string) {
      if (drop(agentId, conversationId)) emptiedOnDaemon(agentId, conversationId);
    },
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
export type SavedDrafts = ReturnType<typeof createSavedDrafts>;

export const savedDrafts = createSavedDrafts();

const NO_SUGGESTIONS: Suggestion[] = [];
const NO_REPLIES: ReplyProposal[] = [];
const NO_LINKS: ChatLink[] = [];
const NO_SUBAGENTS: SubagentView[] = [];

export function useAttention(opts: UseAttentionOptions) {
  const optsRef = useRef(opts);
  const [store] = useState(() => new ChatStore(opts));
  useEffect(() => {
    optsRef.current = opts;
    store.setHost(opts);
  });
  const snap = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const { live, older, failed } = snap;

  useEffect(() => (opts.enabled ? store.connect(optsRef.current.makeClient()) : undefined), [opts.enabled, store]);
  useEffect(() => () => store.dispose(), [store]);

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
  const laneId = opts.lane?.id ?? "";
  const lanes = opts.lane?.lanes ?? null;
  const resolveLane = opts.lane?.resolve;
  const setId = opts.lane?.setId ?? noLaneSwitch;
  const setLaneId = useCallback(
    (id: string, _by: LaneSwitchBy = "hand") => {
      if (id === laneId) return;
      setId(id);
    },
    [laneId, setId],
  );
  const setLanes = opts.lane?.setLanes ?? null;
  const activeLane = useMemo(() => resolveLane?.(lanes, items, snap.agents, laneId) ?? null, [resolveLane, lanes, items, snap.agents, laneId]);
  const flowItems = useMemo(() => laneItems(items, activeLane), [items, activeLane]);
  const flow = useMemo(
    (): FlowLane => ({ lane: activeLane, laneId, setLaneId, lanes, setLanes, laneItems: flowItems }),
    [activeLane, laneId, setLaneId, lanes, setLanes, flowItems],
  );

  const shownAt = useRef(new Map<string, number>());
  const [clock] = useState(() => createActiveClock());
  const activity = opts.activity;
  useEffect(() => activity?.((on) => clock.set(on)), [activity, clock]);
  const shown = useCallback(
    (item: AttentionItem) => {
      shownAt.current.set(idOf(item), clock.now());
    },
    [clock],
  );
  const report = useCallback(
    (item: AttentionItem, action: CardAction, via?: CardVia, facts?: MoveFacts) => {
      const since = shownAt.current.get(idOf(item));
      const dwell = since === undefined ? null : Math.round(clock.now() - since);
      const move = item.outside ? ledgerMoveOf(action, via ?? null, dwell, facts) : null;
      if (move) store.moveOutside(item, move);
      const sender = item.outside && action !== "next" && action !== "later" ? senderKeyOf(item.outside) : null;
      if (sender) optsRef.current.engage?.(sender.agentId, sender.conversationId, "decide");
    },
    [clock, store],
  );
  const [moves] = useState(() => createCardMoves(movesHost(store, opts, () => {})));
  useEffect(() => moves.setHost(movesHost(store, opts, report)));
  const decided = moves.decided;
  const undone = moves.undone;

  const rowReplies = useMemo(
    () =>
      new Map(
        snap.conversations.flatMap((c): Array<[string, ReplyProposal[]]> => (c.reply_proposals?.length ? [[keyOf(c.agent_id, c.id), c.reply_proposals]] : [])),
      ),
    [snap.conversations],
  );
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
        replyProposals: l?.replyProposals ?? rowReplies.get(key) ?? NO_REPLIES,
        links: l?.links ?? NO_LINKS,
        subagents: l?.subagents ?? NO_SUBAGENTS,
      };
    },
    [live, older, failed, store, rowReplies],
  );

  const labelList = snap.labels;
  const labels = useMemo(() => ({ list: labelList, load: store.loadLabels, set: store.setLabels, edit: store.editLabel }), [labelList, store]);
  const reflection = useMemo(() => ({ get: store.getPasses, set: store.setPasses, run: store.reflect }), [store]);
  const suggestions = useMemo(() => ({ decide: store.decideSuggestion, retarget: store.retargetSuggestion }), [store]);
  const replies = useMemo(() => ({ decide: store.decideReply, findPeople: store.findReplyPeople }), [store]);
  const links = useMemo(() => ({ close: store.closeLink, list: store.listLinks, setDefault: store.setLinkDefault }), [store]);
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
      send(item.runtime, text, images, { desk: item.title, labels: item.labels ?? null, origin: "flow" }),
    [send],
  );
  const loadHistory = useCallback((item: AttentionItem) => store.loadThread(item.runtime), [store]);
  const markDone = useCallback((item: AttentionItem) => optsRef.current.markSeen(item.agent_id, item.id), []);
  const markNotDone = useCallback((item: AttentionItem) => optsRef.current.unmarkSeen(item.agent_id, item.id), []);
  const replyOutside = useCallback(
    async (item: AttentionItem, text: string, then: ReplyThen, extra?: OutsideReplyExtra): Promise<OutsideReplyResult> => {
      const r = await store.replyOutside(item, text, then, extra);
      if (r.undone) return { sent: false, error: null, undone: true };
      if (r.sent && !r.error) moves.replied(item, then, r.change);
      else if (r.sent) decided(item, "reply");
      return { sent: r.sent, error: r.error };
    },
    [store, moves, decided],
  );
  const handoffOutside = useCallback(
    async (item: AttentionItem, conversationId: string | null) => {
      const err = await store.handoff(item, conversationId);
      if (!err) moves.handedOff(item);
      return err;
    },
    [store, moves],
  );
  const labelsOf = useCallback((item: AttentionItem): Promise<AccountLabel[] | string> => store.labelsOf(item), [store]);
  const server = snap.server;

  return {
    status: snap.status,
    server,
    commands: useMemo(() => allCommands(server?.advertised, server?.only), [server?.advertised, server?.only]),
    execute: store.execute,
    agents: snap.agents,
    agentsLoaded: snap.agentsLoaded,
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
    keepMoveHere: store.keepMoveHere,
    setMode: store.setMode,
    changeFolder: store.changeFolder,
    archiveConversation: store.archiveConversation,
    renameConversation: store.renameConversation,
    setPurpose: store.setPurpose,
    createDesk: store.createDesk,
    items,
    flow,
    loadHistory,
    loadThread: store.loadThread,
    prefetchThread: store.prefetchThread,
    subscribe: store.follow,
    conversation,
    watchThreads: store.watchThreads,
    watchThread: store.watchThread,
    threadRows: store.threadRows,
    approve,
    decide: store.decide,
    answer: store.answer,
    suggestions,
    replies,
    links,
    reply,
    send,
    cancelQueued: store.cancelQueued,
    reload: store.reload,
    seen: markDone,
    unread: markNotDone,
    read: moves.read,
    later: moves.later,
    laterAsks: moves.laterAsks,
    archive: moves.archive,
    label: moves.label,
    labelsOf,
    undo: moves.undo,
    unarchive: moves.undo,
    handoffPropose: store.handoffPropose,
    handoff: handoffOutside,
    readOutside: store.readOutside,
    composeOutside: store.composeOutside,
    unsendOutside: store.unsendOutside,
    settleUnsent: store.settleUnsent,
    reactOutside: store.reactOutside,
    sentReplies: store.sent,
    searchEmoji: store.searchEmoji,
    searchPeople: store.searchPeople,
    pickPerson: store.pickPerson,
    replyOutside,
    decided,
    shown,
    undone,
  };
}
