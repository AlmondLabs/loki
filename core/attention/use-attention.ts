import type { ChatLink } from "../chat-links.ts";
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
import { idOf, inboxQueue } from "./queue.ts";
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
import { ChatStore, type ChatStoreHost } from "./chat-store.ts";
import { Listeners } from "../listeners.ts";
import { inboxCardSource } from "../analytics.ts";

/** An engagement only the app sees (core/frames.ts focus_add): the mod counts messages and opens itself. */
export type EngageAction = PayloadOf<"focus_add">["action"];

/**
 * What you did with an Inbox card: read it and moved on (`next`, ⌘]), put it off unread (`later`, ⌘[), archived it
 * (done), labelled it, decided an approval, replied, answered its question, opened it, or handed it off.
 */
export type CardAction = "next" | "later" | "archive" | "label" | "approve" | "deny" | "reply" | "answer" | "open" | "handoff";

/** How a card was acted on: a key or a click on the Mac, a swipe or a tap on the phone. */
export type CardVia = "key" | "click" | "swipe" | "tap";

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
  /** How long ⌘] and ⌘[ rest each kind of card (rest.ts), the person's settings; left out, the defaults. */
  returnTimes?: ReturnTimes;
  markSeen: (agentId: string, conversationId: string) => void;
  unmarkSeen: (agentId: string, conversationId: string) => void;
  /** Full transcript from the daemon's store, through the mod (compaction-proof); null when no page came (plan 041). */
  loadLocalHistory?: ChatStoreHost["loadLocalHistory"];
  /** What a page left out of a lean row (plans 041 and 043), from the Mac the chat lives on; null when it did not come. */
  loadLocalStep?: (agentId: string, conversationId: string, row: number) => Promise<WholeRow | null>;
  /** Every open conversation with its digest, from the mod (inbox_list). The list is the inbox's; only live events come from the chat client. */
  /** The Inbox's list, or null when the mod did not answer. */
  listConversations: () => Promise<Array<ConversationInfo & Digest> | null>;
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
  /**
   * The replies its agent proposed that wait on the person or are being drafted (plan 067), live or as the list has
   * them; absent from a face made elsewhere (the site's demo), which has none.
   */
  replyProposals?: ReplyProposal[];
  /** The chat's live links to other chats (plan 067), for its header. */
  links: ChatLink[];
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
 * Handing an outside card to its account's agent (plan 067, U8): what loki proposes, and the hand-off itself, to one
 * of the agent's chats or to a new chat when `conversationId` is null. Both resolve to the reason in words when refused.
 */
export interface HandoffSource {
  handoffPropose: (item: AttentionItem) => Promise<HandoffProposal | string>;
  handoff: (item: AttentionItem, conversationId: string | null) => Promise<string | null>;
}

/**
 * An outside card's thread for the person (plan 068): the whole thread, and their own reply sent in it, which archives
 * the card. Both resolve to the reason in words when refused.
 */
export interface OutsideSource {
  readOutside: (item: AttentionItem, ask?: OutsideWindowAsk) => Promise<OutsideRead | string>;
  /** A mail reply may carry its addressing and the id its undo is by (plan 076). */
  replyOutside: (item: AttentionItem, text: string, then: ReplyThen, extra?: OutsideReplyExtra) => Promise<OutsideReplyResult>;
  /** What a mail card's recipients line starts from (plan 076), or why it could not be read. */
  composeOutside?: (item: AttentionItem) => Promise<MailCompose | string>;
  /** Stop a held mail reply before it goes (plan 076): true when it was stopped. */
  unsendOutside?: (item: AttentionItem, outboxId: string) => Promise<boolean>;
  /** Add or take back the person's reaction on a Slack card's message (plan 079): null when done, else why not. */
  reactOutside?: (item: AttentionItem, messageId: string, name: string, on: boolean) => Promise<string | null>;
  /** The emoji a Slack card's account can react with whose names hold `query` (plan 079), or why they could not be read. */
  searchEmoji?: (item: AttentionItem, query: string) => Promise<EmojiChoice[] | string>;
  /** The people a Slack card's account can mention whose handle or name holds `query` (plan 082), or why not. */
  searchPeople?: (item: AttentionItem, query: string) => Promise<SlackPerson[] | string>;
}

/** What a mail reply carries beside its text (plan 076): how it is addressed (null for reply all) and the id its hold is undone by. */
export interface OutsideReplyExtra {
  mail?: MailAddressing | null;
  outbox_id?: string | null;
}

/**
 * How a reply on an outside card went (plan 070, KTD6): whether it was sent, and the reason for what failed, the send or
 * the move after it. A sent reply is never sent again, so its box clears on `sent` even when `error` is set.
 */
export interface OutsideReplyResult {
  sent: boolean;
  error: string | null;
  /** A held mail reply was stopped before it went (plan 076): nothing was sent and nothing moved. */
  undone?: true;
}

/**
 * How a read (⌘]) or a later (⌘[) went (plan 070): the reason in words when its write-back failed, and the card is as
 * it was; `ask` when a second later press should ask when the card comes back (R7), and nothing was done yet; and the
 * rest it set, null when it set none (a stopped agent moved past for this visit, a Slack card read to its end, a failure).
 */
export interface MoveResult {
  error: string | null;
  ask: boolean;
  rest: Rest | null;
}

/**
 * What a move tells the ledger beyond its action (plan 070, KTD11): when its rest brings the card back, the labels it
 * put on, whether the person picked the time, and for a reply the key that followed it. Analytics never sees these.
 */
export type MoveFacts = Pick<OutsideMove, "return_at" | "labels" | "picked" | "after_reply">;

/**
 * The ledger's move for one Inbox decision or undo on an outside card (plans 069 and 070), or null for a decision that
 * is no move out there (approve, deny, answer, open). ⌘] is reported as `next` in analytics and kept as `read` here.
 */
export function ledgerMoveOf(action: CardAction | "undo", via: CardVia | null, dwellMs: number | null, facts: MoveFacts = {}): OutsideMove | null {
  if (action === "approve" || action === "deny" || action === "answer" || action === "open") return null;
  return { action: action === "next" ? "read" : action, via, dwell_ms: dwellMs, ...facts };
}

/** What the moves ask of the app and the store, read at call time; a test hands in fakes and its own clock. */
export interface CardMovesHost {
  store: Pick<ChatStore, "markReadOutside" | "markUnreadOutside" | "archiveOutside" | "labelOutside" | "restoreOutside" | "archiveConversation">;
  rests: () => Record<string, Rest> | undefined;
  rest: (agentId: string, conversationId: string, rest: Rest) => void;
  markSeen: (agentId: string, conversationId: string) => void;
  unmarkSeen: (agentId: string, conversationId: string) => void;
  returnTimes: () => ReturnTimes | undefined;
  now: () => number;
  /** Keep one decision in analytics and, for an outside card, its account's ledger with the move's facts. */
  report: (item: AttentionItem, action: CardAction, via?: CardVia, facts?: MoveFacts) => void;
  /** Keep a move taken back in analytics. */
  reportUndone: (item: AttentionItem, action: CardAction) => void;
}

/**
 * One move on a card, kept so an undo can reverse exactly it: the rest before it when it set one, what it wrote
 * out there, and the seen mark to put back (`mark` after a later unmarked a read card, `unmark` after a read of an
 * unread one).
 */
interface MoveTaken {
  action: CardAction;
  rested: boolean;
  prev: Rest | undefined;
  change: OutsideChange | null;
  seen: "mark" | "unmark" | null;
}

/**
 * One move on a card's undo stack, kept from before its first wait so an undo pressed while it is still being written
 * finds it: `done` resolves to the move once it has landed, or null when it failed, and `move` holds that answer.
 */
interface MoveEntry {
  done: Promise<MoveTaken | null>;
  move: MoveTaken | null | undefined;
}

/**
 * The person's moves on Inbox cards (plan 070, U6), the same on a chat, an email and a Slack card: read (⌘]), later
 * (⌘[), archive (⌘E) and label, each turned into its write-back out there, its rest, its seen mark and its report, and
 * kept so each undo (⌘Z, R14) takes back exactly the newest one left, waiting for it when it is still being written. A
 * failed write-back changes nothing here and resolves to the reason. Outside React, so a test drives it with a fake host and clock; useAttention keeps one.
 */
export function createCardMoves(first: CardMovesHost) {
  /** The host as last set: useAttention's options are new on every render, so it hands in a fresh one after each. */
  let host = first;
  const setHost = (next: CardMovesHost): void => {
    host = next;
  };
  /** Each card's moves, oldest first, so undo after undo takes them back newest first (R14). */
  const taken = new Map<string, MoveEntry[]>();
  /** The last decision, so a Next straight after acting on the same card reads as moving on (analytics.ts does the same). */
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
  /**
   * Put a move on `item`'s stack before it waits on anything, and hand back how to settle it: with the move it took, or
   * with null when it failed, which takes it off the stack again. The first answer stands, so a `finally` can settle
   * null after an answer without changing it, and a move that threw is settled as failed.
   */
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
  /** Keep a move that waited on nothing. */
  const keep = (item: AttentionItem, move: Partial<MoveTaken> & { action: CardAction }) => begin(item)(move);
  const rest = (item: AttentionItem, r: Rest | null) => {
    if (r) host.rest(item.agent_id, item.id, r);
    return r;
  };
  /** The read rest ⌘] gives `item` now: the person's first rung for its kind, climbing while nothing new comes. */
  const readRest = (item: AttentionItem, movedOn: boolean) => restAfterNext(item, prevOf(item), movedOn, host.now(), readFirstMs(times(), cardKindOf(item)));
  /** The later rest ⌘[ gives `item` now, and whether the press asks when instead. */
  const laterRest = (item: AttentionItem) => restAfterLater(item, prevOf(item), host.now(), laterMs(times(), cardKindOf(item)));

  /** Read (⌘]): seen in loki and read out there, then a read rest; a Slack card read has ended, so it rests no more. */
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
      // A stopped agent never rests (restAfterNext gives null): the press moves past it for this visit only.
      const r = rest(item, change?.ended ? null : readRest(item, movedOn));
      settle({ action: "next", rested: !!r, prev, change, seen: item.unread ? "unmark" : null });
      note(item, "next", via, { return_at: r?.until ?? null });
      return { error: null, ask: false, rest: r };
    } finally {
      settle(null);
    }
  };

  /** Whether ⌘[ on `item` now would ask when it comes back (R7): the second press in a row while nothing new came. */
  const laterAsks = (item: AttentionItem): boolean => laterRest(item)?.ask ?? false;

  /**
   * Later (⌘[): the card stays unread, in loki and out there, and comes back after the kind's return time, or at
   * `until` (ISO), the person's pick. A press that should ask does nothing without `until` and resolves `ask`, so the
   * deck asks and calls again with the pick; a stopped agent is moved past for this visit with no rest.
   */
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
      // A card already read is unmarked, so it shows unread; an email follows Gmail's mark, and loki's goes with it.
      if (!item.unread) host.unmarkSeen(item.agent_id, item.id);
      const r = rest(item, until === undefined ? next.rest : { ...next.rest, until });
      settle({ action: "later", rested: true, prev, change, seen: item.unread ? null : "mark" });
      note(item, "later", via, { return_at: r?.until ?? null, picked: until !== undefined });
      return { error: null, ask: false, rest: r };
    } finally {
      settle(null);
    }
  };

  /** Archive (⌘E): a chat is archived, an outside card's thread is archived out there; resolves to the reason, or null. */
  const archive = async (item: AttentionItem, via?: CardVia): Promise<string | null> => {
    const settle = begin(item);
    try {
      if (item.outside) {
        const w = await host.store.archiveOutside(item);
        if (w.error) return w.error;
        settle({ action: "archive", change: w.change });
      } else {
        const err = await host.store.archiveConversation(item.id, true, "inbox", item.agent_id);
        if (err) return err;
        settle({ action: "archive" });
      }
      note(item, "archive", via);
      return null;
    } finally {
      settle(null);
    }
  };

  /** Put Gmail labels, by id, on an email card's thread (R12); the card stays for the next key. Resolves to the reason, or null. */
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

  /**
   * A reply on an outside card was sent and the key's move after it went (R11, KTD6): the reply is a decision, and the
   * move rests the card as that key would and is kept, so an undo takes back the move and never the reply.
   */
  const replied = (item: AttentionItem, then: ReplyThen, change: OutsideChange | null): void => {
    // A comment sent alone on a Jira card is no decision (plan 083, KTD11): the card stays where it is, unread, its
    // events still new, and the person's next key is the move.
    if (then === "stay" && item.outside?.provider === "jira") return;
    const prev = prevOf(item);
    let r: Rest | null = null;
    if (then === "archive") keep(item, { action: "archive", change });
    else if (then === "read") {
      host.markSeen(item.agent_id, item.id);
      r = rest(item, change?.ended ? null : readRest(item, true));
      keep(item, { action: "next", rested: !!r, prev, change, seen: item.unread ? "unmark" : null });
    } else {
      // As later does: a card already read is unmarked, so it comes back unread, and an undo marks it seen again.
      if (!item.unread) host.unmarkSeen(item.agent_id, item.id);
      r = rest(item, laterRest(item)?.rest ?? null);
      keep(item, { action: "later", rested: !!r, prev, change, seen: item.unread ? null : "mark" });
    }
    note(item, "reply", undefined, { after_reply: then, return_at: r?.until ?? null });
  };

  /** A hand-off went (plan 067): a decision, and the card's last move, which an undo does not take back. */
  const handedOff = (item: AttentionItem): void => {
    keep(item, { action: "handoff" });
    note(item, "handoff");
  };

  /** Reverse what `move` wrote: out there, or a chat's archive. Resolves to the reason when it could not be, or null. */
  const writeBack = (item: AttentionItem, move: MoveTaken): Promise<string | null> => {
    if (move.change) return host.store.restoreOutside(item, move.change);
    if (move.action === "archive" && !item.outside) return host.store.archiveConversation(item.id, false, "inbox_undo", item.agent_id);
    return Promise.resolve(null);
  };

  /**
   * Take back the newest move on `item` (R14), waiting for it first when it is still being written: what it wrote out
   * there first, then a chat's archive, its rest and its seen mark. Resolves to the reason when it could not be, and the
   * move stays to be tried again; "handed off" after a hand-off, which is not undone; and null when it was taken back,
   * when the move it waited on failed and so changed nothing, or when there was nothing to take back.
   */
  const undo = async (item: AttentionItem): Promise<string | null> => {
    const stack = stackOf(item);
    const entry = stack.at(-1);
    if (!entry) return null;
    if (entry.move?.action === "handoff") return "handed off";
    // Off the stack before the wait, so a second undo pressed meanwhile reaches the move before this one.
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

  /**
   * Log an Inbox decision the deck made by other means (approve, answer, open), and today's Next: it rests the card as
   * read, while the deck marks it seen itself.
   */
  const decided = (item: AttentionItem, action: CardAction, via?: CardVia): void => {
    if (action === "next") {
      const prev = prevOf(item);
      const r = rest(item, readRest(item, movesOn(last, idOf(item))));
      keep(item, { action: "next", rested: !!r, prev });
    }
    note(item, action, via);
  };

  /** Today's undo of a Next or an Archive, whose seen mark or archive the deck takes back itself: the rest comes back. */
  const undone = (item: AttentionItem, action: "next" | "archive"): void => {
    const stack = stackOf(item);
    const move = stack.at(-1)?.move;
    if (action === "next") host.rest(item.agent_id, item.id, restUndone(move?.action === "next" ? move.prev : undefined, host.now()));
    if (move?.action === action) stack.pop();
    host.reportUndone(item, action);
  };

  return { read, later, laterAsks, archive, label, replied, handedOff, undo, decided, undone, setHost };
}

/** The moves' host from useAttention's options and store, as they stand at this render. */
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
    // A move taken back: the ranking's miss, or a slip. On an outside card the ledger keeps the undo as a move of its own.
    reportUndone: (item, action) => {
      opts.capture?.("inbox_card_undone", { action, ...inboxCardSource(item) });
      const move = item.outside ? ledgerMoveOf("undo", null, null) : null;
      if (move) store.moveOutside(item, move);
    },
  };
}

/** A card-moves registry, as `createCardMoves` returns it. */
export type CardMoves = ReturnType<typeof createCardMoves>;

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
/** No reply proposals, likewise. */
const NO_REPLIES: ReplyProposal[] = [];
/** No links: one array, so a chat's face stays the same while it has none. */
const NO_LINKS: ChatLink[] = [];

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
        ...inboxCardSource(item),
        turn_id: item.outside ? null : store.turnOf(item.agent_id, item.id),
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
  /** One Inbox decision in analytics, and for an outside card in its account's ledger. */
  const report = useCallback(
    (item: AttentionItem, action: CardAction, via?: CardVia, facts?: MoveFacts) => {
      const since = shownAt.current.get(idOf(item));
      const props = cardProps(item);
      const dwell = since === undefined ? null : Math.round(clock.now() - since);
      optsRef.current.capture?.("inbox_card_decided", {
        action,
        ...(via ? { via } : {}),
        ...props,
        dwell_ms: dwell,
      });
      // A move on an outside card also goes to its account's ledger, with who and what it was (plan 069), and with its
      // return time, labels, pick and following key (plan 070), which analytics never carries.
      const move = item.outside ? ledgerMoveOf(action, via ?? null, dwell, facts) : null;
      if (move) store.moveOutside(item, move);
      // Working with an email (plan 067, R9) lifts that sender's next thread too: its focus is learned by the sender.
      // Reading it or putting it off is not working with it.
      const sender = item.outside && action !== "next" && action !== "later" ? senderKeyOf(item.outside) : null;
      if (sender) optsRef.current.engage?.(sender.agentId, sender.conversationId, "decide");
    },
    [clock, cardProps, store],
  );
  /** The moves on cards and their undo (createCardMoves), kept for the life of the hook so an undo finds its move. */
  // The report reads the dwell clocks, so it is handed in by the effect below, which runs before any press can.
  const [moves] = useState(() => createCardMoves(movesHost(store, opts, () => {})));
  useEffect(() => moves.setHost(movesHost(store, opts, report)));
  const decided = moves.decided;
  const undone = moves.undone;
  /** An agent pill chosen in the Inbox (null: All). */
  const filtered = useCallback((agent: string | null) => {
    optsRef.current.capture?.("inbox_filtered", { agent });
  }, []);

  /** Each listed chat's waiting reply proposals by key, from its row (plan 067), for chats this client does not follow. */
  const rowReplies = useMemo(
    () =>
      new Map(
        snap.conversations.flatMap((c): Array<[string, ReplyProposal[]]> => (c.reply_proposals?.length ? [[keyOf(c.agent_id, c.id), c.reply_proposals]] : [])),
      ),
    [snap.conversations],
  );
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
        // A chat not followed here has its waiting replies on its list row (plan 067).
        replyProposals: l?.replyProposals ?? rowReplies.get(key) ?? NO_REPLIES,
        links: l?.links ?? NO_LINKS,
      };
    },
    [live, older, failed, store, rowReplies],
  );

  /** Labels on chats (plan 022): the list every chip takes its colour from, and the calls that change them. */
  const labelList = snap.labels;
  const labels = useMemo(() => ({ list: labelList, load: store.loadLabels, set: store.setLabels, edit: store.editLabel }), [labelList, store]);
  /** The background passes (daemon/passes.ts): whether reflection and Learn run, and a reflection pass by hand. */
  const reflection = useMemo(() => ({ get: store.getPasses, set: store.setPasses, run: store.reflect }), [store]);
  /** The person's actions on a chat's suggestions (plan 049), carried out by the Mac the chat lives on. */
  const suggestions = useMemo(() => ({ decide: store.decideSuggestion, retarget: store.retargetSuggestion }), [store]);
  /** The person's action on a reply its agent proposed (plan 067, KTD9), carried out by the Mac the chat lives on. */
  const replies = useMemo(() => ({ decide: store.decideReply }), [store]);
  /** Chat links (plan 067): closing one, and Preferences' list and default duration. */
  const links = useMemo(() => ({ close: store.closeLink, list: store.listLinks, setDefault: store.setLinkDefault }), [store]);
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
  /**
   * The person's reply on an outside card (plan 068), then the key's move (plan 070, R11); once sent it is an Inbox
   * decision, kept in the ledger (plan 069), even when the move after it failed. A move that went rests the card as
   * its key would and is what an undo takes back; the reply stays sent.
   */
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
  /** A hand-off of an outside card to its owner's chat (plan 067); once made it is an Inbox decision too (plan 069). */
  const handoffOutside = useCallback(
    async (item: AttentionItem, conversationId: string | null) => {
      const err = await store.handoff(item, conversationId);
      if (!err) moves.handedOff(item);
      return err;
    },
    [store, moves],
  );
  /**
   * The labels an email card's account has, for the label picker (plan 070, R12), or the reason they could not be had.
   */
  const labelsOf = useCallback((item: AttentionItem): Promise<AccountLabel[] | string> => store.labelsOf(item), [store]);
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
    replies,
    links,
    reply,
    send,
    cancelQueued: store.cancelQueued,
    reload: store.reload,
    seen: markDone,
    unread: markNotDone,
    /** ⌘] on any card (plan 070, R5): seen, read out there, rested; resolves to a MoveResult. */
    read: moves.read,
    /** ⌘[ on any card (R6, R7): unread, put off; resolves `ask` on a second press until called again with the pick. */
    later: moves.later,
    /** Whether ⌘[ on a card now would ask when it comes back, so the deck can ask before the press. */
    laterAsks: moves.laterAsks,
    /** ⌘E on any card (R9): a chat archived, an outside thread archived out there; resolves to the reason or null. */
    archive: moves.archive,
    /** Put Gmail labels, by id, on an email card (R12); the card stays. Resolves to the reason or null. */
    label: moves.label,
    labelsOf,
    /** Take back the last move on a card (R14), whatever its kind; resolves to the reason, "handed off", or null. */
    undo: moves.undo,
    /** Undo of an archive, on a chat or an outside card: the same as `undo` once the archive was the card's last move. */
    unarchive: moves.undo,
    handoffPropose: store.handoffPropose,
    handoff: handoffOutside,
    readOutside: store.readOutside,
    composeOutside: store.composeOutside,
    unsendOutside: store.unsendOutside,
    reactOutside: store.reactOutside,
    searchEmoji: store.searchEmoji,
    searchPeople: store.searchPeople,
    replyOutside,
    /** Log an Inbox decision (the deck calls it; the same actions elsewhere are not Inbox decisions). */
    decided,
    shown,
    undone,
    filtered,
  };
}
