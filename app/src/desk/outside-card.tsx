import { useThreadPreview } from "../item/preview";
import { ItemMailThread, itemSlackRow } from "../item/outside-rows";
import { ItemReplyBox } from "../item/reply-box";
import { ItemHeader } from "../item/item-header";
import { ActionBar, type VerbControl } from "../item/action-bar";
import { outsideItem, type ItemVerb } from "../item/item-view";
import type {
  EmojiChoice,
  JiraCardTicket,
  SlackPerson,
  MailAddressing,
  MailCompose,
  OutsideFacts,
  OutsideMessage,
  OutsideRead,
  OutsideWindow,
  OutsideWindowAsk,
} from "../../../core/frame-types.ts";
import {
  Fragment,
  useCallback,
  useEffect,
  useEffectEvent,
  useRef,
  useState,
  useSyncExternalStore,
  type ChangeEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type RefObject,
  type SyntheticEvent,
} from "react";
import type { AttentionItem } from "../../../core/attention/model.ts";
import type { OutsideSource } from "../../../core/attention/use-attention.ts";
import { sentKey, type SentReplies, type SentReply, type SentSnapshot } from "../../../core/attention/sent-replies.ts";
import { Button, Chip, Meta, TextArea } from "../components";
import { KEYMAP, chordIds, cmdHeld, formatKeys, keyFor, type Platform } from "../shell/keymap";
import { keyboard } from "./env";
import { scrollWithin } from "../shared/scroll-within";
import { ago, deckKey } from "./catch-up-parts";
import { CardFace, CardHead, ReachTag } from "./card-head";
import { JiraTicket, JiraTicketHead } from "./jira-ticket";
import { openExternal } from "./env";
import { LinkedText, MailHtml } from "./mail-html";
import { MailAddressLine, addressOf, asRecipient, startAddressing, suggest } from "./mail-address";
import { useMentions, type MentionSource } from "./mentions";
import { MAIL_INDENT, MailThread, firstLine, senderName } from "./mail-thread";
import { NewLine, SlackThread, loadLabel } from "./slack-thread";
import { toggleReaction, useQuickEmoji } from "./slack-reactions";
import { cardKey, type OpenedThread } from "./deck-moves";
import { useSeededReply } from "./use-seeded-reply";
import {
  ARCHIVE_TITLE,
  CAME_FROM,
  HANDOFF_TITLE,
  LATER_TITLE,
  MARK,
  READ_TITLE,
  SEND_NOTE,
  SEND_TITLE,
  disconnectedText,
  headWhat,
  replyPlace,
  ticketAddress,
} from "./outside-words";

/**
 * An outside card (plan 067, U3): a Gmail or Slack thread or a Jira ticket in the Inbox, not a chat. It shows who wrote, about what,
 * which account and agent it belongs to (R10), and the whole thread read from its account (plan 068), with a box for
 * the person's own reply. It is never a Conversation: the reply goes to the thread, not to an agent. The phone draws
 * the same thread with `OutsideThread`. What it says for each service is in `outside-words`.
 */

/** The thread's last messages, one paragraph each, as plain text; the phone draws the same inside its card. */
export function OutsideLines({ facts, touch = false }: { facts: OutsideFacts; touch?: boolean }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: touch ? "var(--phone-space-3)" : 12 }}>
      {facts.lines.map((line, i) => (
        <p
          key={i}
          style={{ margin: 0, whiteSpace: "pre-wrap", overflowWrap: "anywhere", fontSize: touch ? "var(--phone-text-body)" : "var(--loki-text-body)" }}
        >
          {line}
        </p>
      ))}
    </div>
  );
}

/**
 * What a follow-up card says of the chat its thread went to before (R19): that chat's title when the list has it, else
 * that it went to a chat; null for a thread never handed off.
 */
export function wentTo(o: OutsideFacts, items: readonly AttentionItem[]): string | null {
  if (!o.handoff_conversation_id) return null;
  const chat = items.find((i) => !i.outside && i.agent_id === o.owner_agent_id && i.id === o.handoff_conversation_id);
  return chat?.title ? `went to ${chat.title}` : "went to a chat before";
}

/** What a Slack card's window can do next (plan 077): load more on a side, open a post's thread, go back to the channel. */
export interface ThreadControls {
  load: (direction: "before" | "after") => void;
  openThread: (threadTs: string) => void;
  /** Back to the channel or DM view, when the person opened this thread from it (R11); absent otherwise. */
  back?: () => void;
  /** The side a load is reading now. */
  busy: "before" | "after" | null;
  /**
   * Add the person's reaction to a message, or take it back (plan 079): the pill changes at once and goes back if Slack
   * refuses. Absent where the card cannot react (a source without it).
   */
  react?: (messageId: string, choice: EmojiChoice, on: boolean) => void;
  /** The emoji the account can react with whose names hold `query`; empty when they could not be read. */
  searchEmoji?: (query: string) => Promise<EmojiChoice[]>;
  /** The person's quick reactions (plan 084): their most used in Slack, five, for the hover bar and the picker's keys. */
  quick?: EmojiChoice[];
}

/** What a card's thread is read from, and, for a Slack card, what reacts on it (plan 079). */
export type OutsideThreadSource = Pick<OutsideSource, "readOutside" | "reactOutside" | "searchEmoji" | "searchPeople" | "sentReplies">;

/**
 * What a card's thread is read and reacted through, taken from everything the Inbox holds; null when it cannot read
 * threads. Each is passed on, so a card offers reacting (plan 079) and mentioning (plan 082) wherever its source can.
 */
export function threadSourceOf(chats: Partial<OutsideThreadSource>): OutsideThreadSource | null {
  const { readOutside, reactOutside, searchEmoji, searchPeople, sentReplies } = chats;
  if (!readOutside) return null;
  return {
    readOutside,
    ...(sentReplies ? { sentReplies } : {}),
    ...(reactOutside ? { reactOutside } : {}),
    ...(searchEmoji ? { searchEmoji } : {}),
    ...(searchPeople ? { searchPeople } : {}),
  };
}

/** Where a thread stands on the card: read from its account, still being read, or why it could not be. */
export type ThreadState =
  | { kind: "loading" }
  | {
      kind: "read";
      messages: OutsideMessage[];
      window?: OutsideWindow | null;
      controls?: ThreadControls;
      /** The thread the person opened on the card, which a reply goes into (plan 085); null in its own view. */
      opened?: string | null;
      /** A Jira ticket's address, as the read gave it. */
      link?: string | null;
      /** A Jira card's ticket (plan 089), from the opening read; absent from an older Mac, whose card draws as before. */
      ticket?: JiraCardTicket | null;
    }
  | { kind: "failed"; message: string };

/** What the card is showing: for which card and view, and what came back, with any load in flight. */
export interface Shown {
  /** The card and view it was read for, and the read itself, which a newer message makes again. */
  view: string;
  tag: string;
  messages: OutsideMessage[];
  window: OutsideWindow | null;
  busy: "before" | "after" | null;
  failed: string | null;
  /** A Jira ticket's address, as the read gave it. */
  link: string | null;
  /** A Jira card's ticket (plan 089): only the opening read gives it, so a load of earlier comments keeps this one. */
  ticket: JiraCardTicket | null;
}

/** The first message after a thread's pinned first message, which "load earlier" loads before. */
const firstLoaded = (messages: readonly OutsideMessage[], w: OutsideWindow) =>
  (w.view === "thread" ? messages.find((m) => m.id !== w.thread_ts) : messages[0])?.id ?? null;

/**
 * What a load adds to the card (plan 077): the messages it read, before or after what is there, and what more there is.
 * Everything else the card shows stays, a Jira card's ticket among it, since a load reads comments alone (plan 089).
 */
export function withLoaded(now: Shown, out: OutsideRead, w: OutsideWindow, direction: "before" | "after"): Shown {
  const rest = now.messages.filter((m) => !out.messages.some((n) => n.id === m.id));
  const pinned = w.view === "thread" ? rest.filter((m) => m.id === w.thread_ts) : [];
  const body = rest.filter((m) => !pinned.includes(m));
  const more = out.window ?? w;
  return {
    ...now,
    busy: null,
    messages: direction === "before" ? [...pinned, ...out.messages, ...body] : [...rest, ...out.messages],
    window: direction === "before" ? { ...w, more_before: more.more_before } : { ...w, more_after: more.more_after },
  };
}

/** A Slack message time as text that sorts in time order, so two compare as strings. */
const tsOrder = (ts: string): string => {
  const [s = "", f = ""] = ts.split(".");
  return `${s.padStart(12, "0")}.${f.padEnd(6, "0")}`;
};

/**
 * What a Slack card reads when a newer message comes while it shows window `w` (plan 090): the view it shows, never
 * the one the Mac would open on now. A thread is read whole, as an opened one is; a channel or DM reads on from the last
 * message shown. Null when the channel or DM has more after what was loaded: load later reaches the new message.
 */
export function refreshAsk(messages: readonly OutsideMessage[], w: OutsideWindow): OutsideWindowAsk | null {
  if (w.view === "thread") return w.thread_ts ? { view: "thread", thread_ts: w.thread_ts } : null;
  const last = messages.at(-1)?.id;
  return last && !w.more_after ? { view: "channel", direction: "after", from: last } : null;
}

/**
 * What a refresh of a Slack card adds (plan 090): the messages newer than the last one shown go at the end, and each
 * shown message takes its reactions as they are now. Nothing above moves: the rows, the New line and the mention look
 * stay as they were drawn. A thread with replies after what was loaded keeps that gap and counts the replies in it.
 */
export function withNewer(now: Shown, out: OutsideRead): Shown {
  const w = now.window;
  if (!w) return now;
  const fresh = new Map(out.messages.map((m) => [m.id, m]));
  const messages = now.messages.map((m) => {
    const f = fresh.get(m.id);
    if (!f) return m;
    const next = { ...m };
    if (f.reactions) next.reactions = f.reactions;
    else delete next.reactions;
    return next;
  });
  const last = tsOrder(now.messages.at(-1)?.id ?? "");
  const shown = new Set(now.messages.map((m) => m.id));
  const newer = out.messages.filter((m) => !shown.has(m.id) && tsOrder(m.id) > last);
  const more = out.window?.more_after ?? false;
  if (w.more_after) return { ...now, messages, window: { ...w, more_after: more === true ? true : newer.length } };
  return { ...now, messages: [...messages, ...newer], window: { ...w, more_after: more } };
}

/**
 * What a Slack card's thread reacts with (plans 079, 084): reacting, which shows at once on what the card holds and
 * goes back if Slack refuses; the emoji search; and the person's quick reactions. Empty where the source cannot react.
 */
function useReactControls(
  item: AttentionItem,
  source: OutsideThreadSource | null,
  setShown: (change: (now: Shown | null) => Shown | null) => void,
  tag: string,
): Pick<ThreadControls, "react" | "quick" | "searchEmoji"> {
  const o = item.outside;
  const search = source?.searchEmoji;
  const searchEmoji = search ? (q: string) => search(item, q).then((r) => (typeof r === "string" ? [] : r)) : null;
  const reactOutside = source?.reactOutside;
  const quick = useQuickEmoji(o?.provider === "slack" && reactOutside ? o.account_id : null, searchEmoji);
  const setReactions = (messageId: string, change: (m: OutsideMessage) => OutsideMessage["reactions"]) =>
    setShown((now) => (now?.tag === tag ? { ...now, messages: now.messages.map((m) => (m.id === messageId ? { ...m, reactions: change(m) } : m)) } : now));
  const react = (messageId: string, choice: EmojiChoice, on: boolean) => {
    if (!reactOutside) return;
    setReactions(messageId, (m) => toggleReaction(m.reactions ?? [], choice, on));
    void reactOutside(item, messageId, choice.name, on).then((refused) => {
      if (refused !== null) setReactions(messageId, (m) => toggleReaction(m.reactions ?? [], choice, !on));
    });
  };
  return { ...(reactOutside ? { react, quick } : {}), ...(searchEmoji ? { searchEmoji } : {}) };
}

const NO_SENT: SentSnapshot = { replies: [], went: 0 };

/** The replies the person sent alone in a thread (plan 086), from the store when there is one. */
function useSentReplies(store: SentReplies | null, key: string): SentSnapshot {
  const subscribe = useCallback((fn: () => void) => (store && key ? store.subscribe(key, fn) : () => {}), [store, key]);
  const read = () => (store && key ? store.get(key) : NO_SENT);
  return useSyncExternalStore(subscribe, read, read);
}

/** A sent reply as the thread draws it until the thread is read again: the person's own, at the end of the thread. */
const standIn = (r: SentReply, facts: OutsideFacts, opened: boolean): OutsideMessage => ({
  id: r.id,
  sender: "you",
  at: r.at,
  text: r.text,
  mine: true,
  // A Slack thread's replies sit under its first message, in the card's own thread or one opened on it.
  ...(facts.provider === "slack" && (opened || facts.thread_id.includes(":")) ? { in_thread: true } : {}),
});

/** What a card's thread shows of the replies the person sent alone in the view it is on (plan 086). */
interface SentStandIns {
  /** How many went, which the thread is read again on. */
  went: number;
  standIns: OutsideMessage[];
  /** A read came back that was made once `upTo` had gone: those are in it now. */
  settle: (upTo: number) => void;
}

/** The replies sent alone in the view a card is on: its own thread, or the post's thread opened on it (plan 085). */
function useSentStandIns(source: OutsideThreadSource | null, facts: OutsideFacts | undefined, threadTs: string | null): SentStandIns {
  const store = source?.sentReplies ?? null;
  const key = facts ? sentKey(facts.account_id, facts.thread_id, threadTs) : "";
  const sent = useSentReplies(store, key);
  return {
    went: sent.went,
    standIns: facts ? sent.replies.map((r) => standIn(r, facts, threadTs !== null)) : [],
    settle: (upTo) => {
      if (key) store?.settle(key, upTo);
    },
  };
}

/**
 * What a read of a Jira card asks beyond its window (plan 089): the ticket, on the opening read, and on a load of
 * earlier comments while the card shows the ticket, so the load brings comments alone. A card the Mac answered with the
 * older log of comments and changes loads more of that log; a Gmail or Slack card asks nothing more.
 */
export const ticketAsk = (o: OutsideFacts | undefined, showsTicket: boolean): OutsideWindowAsk =>
  o?.provider === "jira" && showsTicket ? { ticket: true } : {};

/**
 * The card's thread (plan 068), read from its account when the card comes up and again when a new message arrives in
 * it; without a source (a demo, an old daemon) it stays loading and the card shows its last lines. A Slack card's
 * window (plan 077) loads more on either side and opens a post's thread. A newer message keeps the view and what was
 * loaded (plan 090): it is added at the end, and only another card on top starts afresh (R15). A reply the person sent
 * alone shows at the end at once, and the view is read again once it went (plan 086).
 */
export function useOutsideThread(
  item: AttentionItem,
  source: OutsideThreadSource | null,
  hold?: { opened: OpenedThread | null; setOpened: (opened: OpenedThread | null) => void },
): ThreadState {
  const o = item.outside;
  const key = cardKey(item);
  // The thread the person opened from the channel view, for this card only; another card starts on its own view. The
  // deck holds it when it holds the reply box, so the reply and its keys send into it (plan 085).
  const [ownOpened, setOwnOpened] = useState<OpenedThread | null>(null);
  const opened = hold ? hold.opened : ownOpened;
  const setOpened = hold ? hold.setOpened : setOwnOpened;
  const threadTs = opened?.key === key ? opened.ts : null;
  const ask: OutsideWindowAsk = threadTs ? { view: "thread", thread_ts: threadTs } : {};
  const view = key ? `${key}/${threadTs ?? ""}` : "";
  const newest = o?.newest_message_id ?? "";
  // A Slack card keeps what it shows while new messages come (plan 090); mail and Jira are read whole again.
  const steady = o?.provider === "slack";
  const tag = steady ? view : `${view}/${newest}`;
  const [shown, setShown] = useState<Shown | null>(null);
  const sent = useSentStandIns(source, o, threadTs);
  const went = sent.went;
  // The item changes identity on every list update; the thread is read again only when its newest message does, or
  // when the person's own reply went.
  const read = useEffectEvent((more: OutsideWindowAsk) => source?.readOutside(item, { ...ask, ...ticketAsk(item.outside, true), ...more }) ?? null);
  const settle = useEffectEvent((upTo: number) => sent.settle(upTo));
  // A Slack card already showing this view reads only what is newer (plan 090): the read, none when it has nothing to
  // read, or null when the card reads afresh. One from a Mac older than plan 077 has no window and reads afresh.
  const readNewer = useEffectEvent(() => {
    if (!steady || shown?.tag !== tag || shown.failed !== null || !shown.window) return null;
    const again = refreshAsk(shown.messages, shown.window);
    return { pending: again ? read(again) : null };
  });
  useEffect(() => {
    if (!key) return;
    let live = true;
    const stop = () => {
      live = false;
    };
    const newer = readNewer();
    if (newer) {
      // What is newer goes at the end and the rest stays (plan 090).
      void newer.pending?.then((out) => {
        if (!live || typeof out === "string") return;
        setShown((s) => (s?.tag === tag ? withNewer(s, out) : s));
        if (out.window?.more_after !== true) settle(went);
      });
      return stop;
    }
    void read({})?.then((out) => {
      if (!live) return;
      if (typeof out !== "string") {
        setShown({ view, tag, messages: out.messages, window: out.window, busy: null, failed: null, link: out.link ?? null, ticket: out.ticket ?? null });
        settle(went);
        return;
      }
      // A read again that fails keeps what the card shows, with the reply's stand-in.
      setShown((now) =>
        now?.tag === tag && now.failed === null ? now : { view, tag, messages: [], window: null, busy: null, failed: out, link: null, ticket: null },
      );
    });
    return stop;
  }, [key, tag, view, newest, went]);
  const reacting = useReactControls(item, source, setShown, tag);
  // A newer message reads the thread again; meanwhile the card keeps what it shows.
  if (!key || shown?.view !== view) return { kind: "loading" };
  if (shown.failed !== null) return { kind: "failed", message: shown.failed };
  const messages = [...shown.messages, ...sent.standIns];
  const w = shown.window;
  if (!w) return { kind: "read", messages, link: shown.link, ticket: shown.ticket };
  const load = (direction: "before" | "after") => {
    if (shown.busy) return;
    const from = direction === "before" ? firstLoaded(shown.messages, w) : (shown.messages.at(-1)?.id ?? null);
    if (!from) return;
    setShown({ ...shown, busy: direction });
    void source
      ?.readOutside(item, { ...ask, ...ticketAsk(o, shown.ticket !== null), direction, from })
      .then((out) => setShown((now) => (now?.tag !== tag ? now : typeof out === "string" ? { ...now, busy: null } : withLoaded(now, out, w, direction))));
  };
  const controls: ThreadControls = {
    load,
    openThread: (ts) => setOpened({ key, ts }),
    ...(threadTs ? { back: () => setOpened(null) } : {}),
    busy: shown.busy,
    ...reacting,
  };
  return { kind: "read", messages, window: w, controls, opened: threadTs, link: shown.link, ticket: shown.ticket };
}

/**
 * What a mail card's recipients line starts from (plan 076), read from its account when the card comes up and again
 * when a new message arrives; null while it is read, when it could not be (the line then says the reply goes to all),
 * and for a Slack card.
 */
export function useMailCompose(item: AttentionItem | undefined, source: Pick<OutsideSource, "composeOutside"> | null): MailCompose | null {
  const [state, setState] = useState<{ key: string; compose: MailCompose | null }>({ key: "", compose: null });
  const o = item?.outside;
  const key = o?.provider === "gmail" ? `${o.account_id}/${o.thread_id}/${o.newest_message_id}` : "";
  const read = useEffectEvent(() => (item ? (source?.composeOutside?.(item) ?? null) : null));
  useEffect(() => {
    if (!key) return;
    let live = true;
    void read()?.then((out) => {
      if (live) setState({ key, compose: typeof out === "string" ? null : out });
    });
    return () => {
      live = false;
    };
  }, [key]);
  // What was read for another card is not this one's.
  return state.key === key ? state.compose : null;
}

/** The text a mail reply quotes, as the card shows it behind "•••": the newest mail's, once the thread is read. */
export const quoteOf = (facts: OutsideFacts, state: ThreadState): string | null =>
  facts.provider === "gmail" && state.kind === "read" ? (state.messages.at(-1)?.text ?? null) : null;

/**
 * One message of the thread. A mail before the newest starts folded to its sender, time and first line, as a mail
 * client shows a thread, so a run of near-identical mails (a bill sent again) does not draw the same page three times;
 * a press opens it.
 */
function MessageRow({ m, folded }: { m: OutsideMessage; folded: boolean }) {
  // Only the press is kept; whether it is folded is the thread's to say, so a mail a newer one arrives under folds.
  const [opened, setOpened] = useState(false);
  const open = !folded || opened;
  const size = "var(--phone-text-body)";
  const who = (
    <span style={{ fontSize: size, fontWeight: 600, color: m.mine ? "var(--loki-positive)" : undefined }}>{m.mine ? "you" : senderName(m.sender)}</span>
  );
  if (!open)
    return (
      <button type="button" className="loki-mail-fold" onClick={() => setOpened(true)} aria-expanded={false}>
        {who}
        {m.at && <Meta>{ago(m.at)}</Meta>}
        <span className="loki-mail-fold-line" style={{ fontSize: size }}>
          {firstLine(m.text)}
        </span>
      </button>
    );
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8, minWidth: 0 }}>
        {who}
        {m.at && <Meta>{ago(m.at)}</Meta>}
      </div>
      {m.html ? (
        <MailHtml html={m.html} title={`mail from ${senderName(m.sender)}`} />
      ) : (
        <p style={{ margin: 0, whiteSpace: "pre-wrap", overflowWrap: "anywhere", fontSize: size }}>
          <LinkedText text={m.text} />
        </p>
      )}
    </div>
  );
}

/** No addresses of the person's: one array, so a card given none keeps the same one from draw to draw. */
const NO_ADDRESSES: readonly string[] = [];

/**
 * The thread on the card: every message, oldest first, scrolled to the newest. While it is read, or when it could not
 * be, the card's own last lines stand in, with a line saying so.
 */
export function OutsideThread({
  facts,
  state,
  touch = false,
  own = NO_ADDRESSES,
  items = false,
}: {
  facts: OutsideFacts;
  state: ThreadState;
  touch?: boolean;
  /** The person's own addresses, which a mail's header line says as "you" (plan 078). */
  own?: readonly string[];
  /** Draw the messages with the new chat pane's item components (plan 097, U7), keeping the thread's own behaviour. */
  items?: boolean;
}) {
  const end = useRef<HTMLDivElement>(null);
  // Scrolled when the newest message changes, so events a Jira card loads above what is read leave it where it is.
  const newest = state.kind === "read" ? (state.messages.at(-1)?.id ?? "") : "";
  useEffect(() => {
    const el = end.current;
    if (!newest || !el) return;
    const box = el.closest<HTMLElement>("[data-thread-scroll]");
    if (box) scrollWithin(box, el, "end");
    else el.scrollIntoView({ block: "end" }); // the phone's card scrolls with its page
  }, [newest]);
  // A Jira card drawn as its ticket (plan 089) opens at the ticket's top, so it marks no end to scroll to. On the
  // desktop a Jira card's comments are drawn by the Slack card's rows (plan 091); the phone keeps the plain list.
  if (facts.provider === "jira" && state.kind === "read" && state.ticket)
    return (
      <JiraTicket ticket={state.ticket} touch={touch}>
        {touch ? <ThreadList facts={facts} state={state} /> : <SlackRows facts={facts} state={state} stays items={items} />}
      </JiraTicket>
    );
  if (state.kind !== "read" || state.messages.length === 0) return <ThreadStandIn facts={facts} state={state} touch={touch} />;
  if (touch) return <ThreadList facts={facts} state={state} endRef={end} />;
  if (facts.provider === "gmail")
    return (
      <>
        {items ? <ItemMailThread messages={state.messages} own={own} /> : <MailThread messages={state.messages} own={own} />}
        <div ref={end} />
      </>
    );
  return <SlackRows facts={facts} state={state} items={items} />;
}

/**
 * A Slack or Jira card's messages on the desktop, drawn by the Slack card's rows (plans 074, 091); a Jira card's
 * without what only Slack has, and under its ticket without scrolling away from the ticket's top (`stays`).
 */
function SlackRows({
  facts,
  state,
  stays = false,
  items = false,
}: {
  facts: OutsideFacts;
  state: Extract<ThreadState, { kind: "read" }>;
  stays?: boolean;
  items?: boolean;
}) {
  return (
    <SlackThread
      messages={state.messages}
      newest={facts.newest_message_id}
      window={state.window ?? null}
      controls={state.controls ?? null}
      jira={facts.provider === "jira"}
      stays={stays}
      {...(items ? { row: itemSlackRow(facts.provider) } : {})}
    />
  );
}

/** The card's own last lines while its thread is read, or when it could not be, with a line saying which. */
function ThreadStandIn({ facts, state, touch }: { facts: OutsideFacts; state: ThreadState; touch: boolean }) {
  const failed = state.kind === "failed" ? state.message : null;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: touch ? "var(--phone-space-3)" : 12 }}>
      <Meta wrap negative={failed !== null}>
        {failed !== null ? `could not read the whole thread: ${failed}` : "reading the whole thread…"}
      </Meta>
      <OutsideLines facts={facts} touch={touch} />
    </div>
  );
}

/**
 * The thread as a plain list, oldest first, with the mark `OutsideThread` scrolls to at its end, as the phone draws
 * every card. A Jira card draws the New line before its first unread event, and loads earlier events (KTD14).
 */
function ThreadList({
  facts,
  state,
  endRef,
}: {
  facts: OutsideFacts;
  state: Extract<ThreadState, { kind: "read" }>;
  /** The mark at the end the thread scrolls to; absent under a Jira ticket, which stays at its top. */
  endRef?: RefObject<HTMLDivElement | null>;
}) {
  const jira = facts.provider === "jira";
  const newAt = jira ? state.messages.findIndex((m) => m.unread === true) : -1;
  const { window: w, controls } = state;
  const earlier = jira && w && controls && w.more_before !== false && w.more_before !== 0 ? controls : null;
  const earlierLabel = earlier ? loadLabel("before", true, earlier.busy === "before") : "";
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--phone-space-4)" }}>
      {earlier && (
        <Button size="touch" bare disabled={earlier.busy !== null} onClick={() => earlier.load("before")} style={{ alignSelf: "center" }}>
          {`${earlierLabel[0].toUpperCase()}${earlierLabel.slice(1)}`}
        </Button>
      )}
      {state.messages.map((m, i) => (
        <Fragment key={m.id}>
          {i === newAt && <NewLine />}
          <MessageRow m={m} folded={facts.provider === "gmail" && i < state.messages.length - 1} />
        </Fragment>
      ))}
      {endRef && <div ref={endRef} />}
    </div>
  );
}

/** The deck's chords that reach it from inside the reply box (KTD9): read, later and archive, each sending the text first. */
const DECK_CHORDS = new Set(["inbox.next", "inbox.later", "inbox.archive"]);

/**
 * What a key pressed in the reply box is for: the deck (⌘], ⌘[ and ⌘E, which send the text with their move), sending,
 * opening the recipients line (⌘⇧C, mail only), handing the keys back (Esc), or the text itself (letters, arrows, a
 * new line). A chat or Slack box sends on Enter (the keymap's chat.send); a mail box sends on ⌘Enter and Enter starts a
 * line, as in Gmail (plan 076), since a mail is often more than one line.
 */
export function replyBoxKey(e: KeyboardEvent, os: Platform = keyboard, mail = false): "deck" | "send" | "recipients" | "escape" | "own" {
  const ids = chordIds(e, KEYMAP, os);
  if (cmdHeld(e, os) && ids.some((id) => DECK_CHORDS.has(id))) return "deck";
  if (mail) {
    if (!e.isComposing && e.key === "Enter" && cmdHeld(e, os) && !e.shiftKey && !e.altKey) return "send";
    if (cmdHeld(e, os) && e.shiftKey && e.key.toLowerCase() === "c") return "recipients";
  } else if (!e.isComposing && ids.includes("chat.send")) return "send";
  return e.key === "Escape" ? "escape" : "own";
}

/**
 * The reply box as the deck holds it (KTD9): its text, how a mail reply is addressed (null when unchanged, plan 076),
 * whether a send is under way, why the last one failed, and the send, which the deck turns into the reply and its move.
 */
export interface ReplyBoxControl {
  text: string;
  mail: MailAddressing | null;
  busy: boolean;
  error: string | null;
  onText: (text: string) => void;
  onMail: (mail: MailAddressing) => void;
  onSend: () => void;
  /** The thread opened on the card, which the reply goes into (plan 085), and its change; absent, the card keeps its own. */
  thread?: OpenedThread | null;
  onThread?: (thread: OpenedThread | null) => void;
}

/**
 * The reply box under the thread (plan 068): the person's own words, sent in the thread as they wrote them. On the
 * desktop the deck holds the text (`box`), so ⌘], ⌘[ and ⌘E send it with their move and Enter sends it alone (plan 083); the
 * phone's box keeps its own and sends with `onSend`. A Jira comment the person approved for the agent is added to
 * either box once, after what is there, and goes nowhere until they send it (KTD18). Shift-Enter starts a line; Esc
 * hands the deck's keys back, or closes the deck when the box is empty. A send that fails keeps the text and says why.
 * With `keep`, the unsent text outlives the box (plan 087, KTD7): a card hidden by a lane switch, or gone from the
 * screen any other way, has its words back when it returns.
 */
export function OutsideReply({
  facts,
  onSend,
  box,
  inputRef,
  onTyping,
  onEscapeEmpty,
  touch = false,
  actions = null,
  compose = null,
  quote = null,
  onUndo,
  keep,
  searchPeople,
  inThread = false,
  items = false,
}: {
  /** A thread is open on the card (plan 085): the reply goes into it, and the box says so. */
  inThread?: boolean;
  /** Draw the box as the new chat pane's Composer (plan 097, U7); its behaviour is the same either way. */
  items?: boolean;
  facts: OutsideFacts;
  /** The card's id (`idOf`), under which its unsent text is kept for the session (shared/outside-replies.ts); absent, the text goes with the box. */
  keep?: string;
  /** The people a Slack card's workspace can mention whose handle or name holds `query` (plan 082); absent, no list. */
  searchPeople?: (query: string) => Promise<SlackPerson[]>;
  /**
   * The box's own send, when the deck does not hold it: resolves whether the reply was sent and why what failed did; a
   * sent reply clears the box so it is not sent twice, and an undone one keeps it.
   */
  onSend?: (text: string, mail: MailAddressing | null) => Promise<{ sent: boolean; error: string | null; undone?: true }>;
  /** What a mail card's recipients line starts from (plan 076); null while it is read, or for Slack. */
  compose?: MailCompose | null;
  /** The newest mail's text, which goes quoted under the reply, shown behind "•••". */
  quote?: string | null;
  /** Stop the held reply while the box's own send waits (the phone's undo, plan 076); absent, no undo is offered. */
  onUndo?: () => void;
  /** The deck's hold on the box; absent, the box keeps its own text. */
  box?: ReplyBoxControl;
  /** The card's other moves, drawn on the row after send, so the card has one bar of buttons; a desktop mail box, framed at the thread's end, leaves them to the card. */
  actions?: ReactNode;
  inputRef?: RefObject<HTMLTextAreaElement | null>;
  onTyping?: (typing: boolean) => void;
  onEscapeEmpty?: () => void;
  touch?: boolean;
}) {
  // The phone's box keeps its own text, with the approved Jira comments added (KTD18); with `keep` it outlives the box.
  // The desktop deck keeps its box's text itself.
  const [ownText, setOwnText] = useSeededReply(facts.seeds, keep ?? null, !!box);
  const [ownMail, setOwnMail] = useState<MailAddressing | null>(null);
  const [ownBusy, setBusy] = useState(false);
  const [ownError, setError] = useState<string | null>(null);
  const [lineOpen, setLineOpen] = useState(false);
  const [quoteOpen, setQuoteOpen] = useState(false);
  const text = box ? box.text : ownText;
  const setText = box ? box.onText : setOwnText;
  const mail = box ? box.mail : ownMail;
  const setMail = box ? box.onMail : setOwnMail;
  const busy = box ? box.busy : ownBusy;
  const error = box ? box.error : ownError;
  const off = busy || !!facts.disconnected;
  const isMail = facts.provider === "gmail";
  const shown = compose ? (mail ?? startAddressing(compose)) : null;
  // Mentioning (plan 082): a mail pick writes the name and adds them to To, as Gmail does; a Slack pick writes the
  // handle, which the account's Mac sends as Slack's mention. A Jira comment is plain text, so it offers no one.
  const ownRef = useRef<HTMLTextAreaElement | null>(null);
  const mentionSource: MentionSource | null =
    isMail && shown && compose
      ? {
          now: (q) => {
            const taken = new Set([...shown.to, ...shown.cc, ...shown.bcc].map((e) => addressOf(e).toLowerCase()));
            return suggest(compose.people, q, new Set()).map((p) => ({
              key: p.address,
              label: p.name || p.address,
              sub: p.name ? p.address : null,
              insert: p.name || p.address.split("@")[0],
              onPick: taken.has(p.address.toLowerCase()) ? undefined : () => setMail({ ...shown, to: [...shown.to, asRecipient(p)] }),
            }));
          },
        }
      : facts.provider === "slack" && searchPeople
        ? {
            later: (q) => searchPeople(q).then((people) => people.map((p) => ({ key: p.id, label: p.name, sub: `@${p.handle}`, insert: p.handle }))),
          }
        : null;
  const mentions = useMentions({ text, setText, source: off ? null : mentionSource, ref: ownRef });
  const nobody = !!shown && shown.to.length + shown.cc.length + shown.bcc.length === 0;
  const send = async () => {
    if (off || !text.trim()) return;
    if (nobody) {
      setLineOpen(true);
      return;
    }
    if (box) return box.onSend();
    if (!onSend) return;
    setBusy(true);
    setError(null);
    try {
      const r = await onSend(text, mail);
      if (r.sent) {
        setOwnText("");
        setOwnMail(null);
      }
      if (r.error) setError(r.error);
    } finally {
      setBusy(false);
    }
  };
  const keys = (e: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (mentions.onKeyDown(e)) return;
    const key = replyBoxKey(e.nativeEvent, keyboard, isMail);
    // ⌘], ⌘[ and ⌘E go on to the deck, which sends the text with their move (KTD9).
    if (key === "deck") return;
    // The deck's single keys are its own outside the box; inside, letters are the reply's.
    e.stopPropagation();
    // A chat's or Slack's box sends on Enter, a mail's on ⌘Enter (plan 076); the other Enter starts a line.
    if (key === "send") {
      e.preventDefault();
      void send();
    } else if (key === "recipients") {
      e.preventDefault();
      setLineOpen(true);
    } else if (key === "escape") {
      e.preventDefault();
      if (!text && onEscapeEmpty) onEscapeEmpty();
      else e.currentTarget.blur();
    }
  };
  // The recipients line says who a mail goes to, so the box says only what is written in it.
  const hint = !isMail ? replyPlace(facts, inThread) : shown?.mode === "forward" ? "add a note" : compose ? "reply" : replyPlace(facts);
  const sendKey = isMail ? "cmd+enter" : undefined;
  const signature = shown?.signature !== false ? (compose?.from.find((f) => f.address === (shown?.from ?? compose.default_from))?.signature ?? "") : "";
  const hasSignature = !!compose?.from.find((f) => f.address === (shown?.from ?? compose.default_from))?.signature;
  const size = touch ? "var(--phone-text-body)" : 12;
  // On the desktop a mail's reply is one framed box at the end of the thread, as Gmail's is (plan 078).
  const framed = isMail && !touch;
  const discard = () => {
    setText("");
    if (compose) setMail(startAddressing(compose));
    setLineOpen(false);
  };
  if (items)
    return (
      <ItemReplyBox
        isMail={isMail}
        target={
          isMail ? (
            <MailAddressLine
              compose={compose}
              value={mail}
              onChange={setMail}
              open={lineOpen}
              onOpen={setLineOpen}
              onTyping={onTyping}
              touch={false}
              disabled={off}
              full
            />
          ) : (
            hint
          )
        }
        mentions={mentions.list}
        field={{
          ref: (el: HTMLTextAreaElement | null) => {
            ownRef.current = el;
            if (inputRef) inputRef.current = el;
          },
          value: text,
          disabled: off,
          // The target line already says where it goes; the field says what to do.
          placeholder: isMail ? hint : facts.provider === "jira" ? "write a comment…" : "write a reply…",
          "aria-label": hint,
          onChange: (e: ChangeEvent<HTMLTextAreaElement>) => {
            setText(e.target.value);
            mentions.onCaret(e.target);
          },
          onSelect: (e: SyntheticEvent<HTMLTextAreaElement>) => mentions.onCaret(e.currentTarget),
          onKeyDown: keys,
          onFocus: () => onTyping?.(true),
          onBlur: () => {
            mentions.onCaret(null);
            onTyping?.(false);
          },
        }}
        signature={isMail && compose && hasSignature ? { text: signature, toggle: () => shown && setMail({ ...shown, signature: !signature }) } : null}
        quote={isMail && compose && quote ? { text: quote, forward: shown?.mode === "forward" } : null}
        send={{
          busy,
          disabled: off || !text.trim(),
          title: nobody ? "add someone to send it to first" : SEND_TITLE[facts.provider],
          keys: sendKey ? formatKeys(sendKey) : keyFor("chat.send"),
          onSend: () => void send(),
        }}
        discard={isMail ? { disabled: off || (!text && mail === null), onDiscard: discard } : null}
        error={error}
        actions={isMail ? null : actions}
      />
    );
  return (
    <div
      className={framed ? "loki-mail-compose" : undefined}
      style={framed ? undefined : { display: "flex", flexDirection: "column", gap: touch ? "var(--phone-space-2)" : 8 }}
    >
      {isMail && (
        <div className={framed ? "loki-mail-compose-head" : undefined}>
          <MailAddressLine
            compose={compose}
            value={mail}
            onChange={setMail}
            open={lineOpen}
            onOpen={setLineOpen}
            onTyping={onTyping}
            touch={touch}
            disabled={off}
            full={!touch}
          />
        </div>
      )}
      <div style={{ position: "relative", display: "flex", flexDirection: "column" }}>
        {mentions.list}
        <TextArea
          ref={(el) => {
            ownRef.current = el;
            if (inputRef) inputRef.current = el;
          }}
          size={touch ? "touch" : "sm"}
          bare={framed}
          className={framed ? "loki-mail-compose-text" : undefined}
          value={text}
          rows={touch ? 4 : 3}
          disabled={off}
          placeholder={touch ? `${hint[0].toUpperCase()}${hint.slice(1)}` : hint}
          aria-label={hint}
          onChange={(e) => {
            setText(e.target.value);
            mentions.onCaret(e.target);
          }}
          onSelect={(e) => mentions.onCaret(e.currentTarget)}
          onKeyDown={keys}
          onFocus={() => onTyping?.(true)}
          onBlur={() => {
            mentions.onCaret(null);
            onTyping?.(false);
          }}
        />
      </div>
      {isMail && compose && (hasSignature || quote) && (
        <div className={framed ? "loki-mail-compose-extra" : undefined} style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          {hasSignature && (
            <div style={{ display: "flex", alignItems: "baseline", gap: 8, minWidth: 0 }}>
              {signature ? (
                <span style={{ fontSize: size, color: "var(--loki-muted)", whiteSpace: "pre-wrap", overflowWrap: "anywhere", flex: 1, minWidth: 0 }}>
                  {`-- \n${signature}`}
                </span>
              ) : (
                <Meta style={{ flex: 1 }}>{touch ? "No signature" : "no signature"}</Meta>
              )}
              <button
                type="button"
                className="loki-mail-line-who"
                style={{ flex: "none" }}
                disabled={off}
                onClick={() => shown && setMail({ ...shown, signature: !signature })}
              >
                {signature ? (touch ? "Remove" : "remove") : touch ? "Add signature" : "add signature"}
              </button>
            </div>
          )}
          {quote && (
            <>
              <button
                type="button"
                className="loki-mail-quote-toggle"
                aria-expanded={quoteOpen}
                aria-label={touch ? "Show the quoted mail" : "show the quoted mail"}
                title={
                  touch
                    ? undefined
                    : shown?.mode === "forward"
                      ? "the mail goes under your note, with its files"
                      : "the mail you answer goes quoted under your reply"
                }
                onClick={() => setQuoteOpen(!quoteOpen)}
              >
                •••
              </button>
              {quoteOpen && (
                <div className="loki-mail-quote" style={{ fontSize: size }}>
                  {quote}
                </div>
              )}
            </>
          )}
        </div>
      )}
      <div className={framed ? "loki-mail-compose-foot" : undefined} style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <Button
          size={touch ? "touch" : "sm"}
          tone="positive"
          disabled={off || !text.trim()}
          onClick={() => void send()}
          kbd={touch ? undefined : sendKey ? formatKeys(sendKey) : keyFor("chat.send")}
          title={touch ? "send it as you; the card stays" : nobody ? "add someone to send it to first" : SEND_TITLE[facts.provider]}
        >
          {busy ? (touch ? "Sending…" : "sending…") : touch ? "Send" : "send"}
        </Button>
        {touch && busy && onUndo && (
          <Button size="touch" onClick={onUndo}>
            Undo
          </Button>
        )}
        {touch && !error && !busy && <Meta wrap>{SEND_NOTE[facts.provider]}</Meta>}
        {framed && error && (
          <Meta negative wrap style={{ flex: 1 }}>
            {error}
          </Meta>
        )}
        {framed ? (
          <Button
            size="sm"
            bare
            disabled={off || (!text && mail === null)}
            onClick={discard}
            style={{ marginLeft: "auto" }}
            title="clear the reply and its recipients"
          >
            discard
          </Button>
        ) : (
          actions
        )}
      </div>
      {!framed && error && (
        <Meta negative wrap>
          {error}
        </Meta>
      )}
    </div>
  );
}

/**
 * The card's header (plan 073): the sender's face with the mark of Slack, mail or Jira, who wrote, then where (a Slack
 * channel), what (a mail's subject, a ticket's key and title) and when; the tag for how directly it is meant for the
 * person, a Jira card's link to its ticket, and the badge or the last move's flash. The account is named only when
 * more than one of its service is connected.
 */
export function OutsideHeader({
  facts,
  badge,
  went,
  cameBack,
  link = null,
  ticket = null,
}: {
  facts: OutsideFacts;
  badge: string | null;
  went: string | null;
  cameBack: boolean;
  /** A Jira ticket's address as the read gave it; until then the account's host stands in. */
  link?: string | null;
  /** A Jira card's ticket once read (plan 089): the header then names its type, key and project over its summary. */
  ticket?: JiraCardTicket | null;
}) {
  const who = senderName(facts.sender);
  const mail = facts.provider === "gmail";
  const address = ticketAddress(facts, link);
  const right = (
    <>
      {facts.reach && <ReachTag reach={facts.reach} />}
      {address && (
        <a
          className="loki-mail-link"
          href={address}
          title={address}
          onClick={(e) => {
            e.preventDefault();
            openExternal(address);
          }}
        >
          open in jira
        </a>
      )}
      {badge && <Chip tone="var(--loki-positive)">{badge}</Chip>}
    </>
  );
  if (facts.provider === "jira" && ticket)
    return <JiraTicketHead ticket={ticket} right={right} line={<OutsideHeadLine facts={facts} what={who} went={went} cameBack={cameBack} />} />;
  return (
    <CardHead
      face={<CardFace name={who} src={facts.sender_avatar ?? null} mark={MARK[facts.provider]} />}
      // A mail card is titled by its subject, as Gmail's thread view is (plan 078); each mail then names who wrote it.
      who={mail ? facts.subject || "no subject" : who}
      whoHint={facts.sender_address ? `${who} <${facts.sender_address}>` : undefined}
      line={<OutsideHeadLine facts={facts} what={headWhat(facts)} went={went} cameBack={cameBack} />}
      right={right}
    />
  );
}

/**
 * An outside card's header for the new chat pane's preview (plan 097, U8): the sender's face with its mark, the
 * channel, subject or ticket as the one-line title with its flags, its properties, then when, the account and where it
 * went. The moves are OutsideItemActions, under the reply box.
 */
export function OutsideItemHeader({
  facts,
  unread,
  flash,
  went,
  cameBack,
  thread,
}: {
  facts: OutsideFacts;
  unread: boolean;
  flash: string | null;
  went: string | null;
  cameBack: boolean;
  thread: ThreadState;
}) {
  const view = outsideItem({ facts, messages: thread.kind === "read" ? thread.messages : [], ticket: readHead(thread).ticket, unread });
  const who = senderName(facts.sender);
  return (
    <ItemHeader
      view={view.header}
      lead={<CardFace name={who} src={facts.sender_avatar ?? null} mark={MARK[facts.provider]} />}
      meta={
        <>
          <OutsideHeadLine facts={facts} what={facts.provider === "slack" ? who : null} went={went} cameBack={cameBack} />
          {flash && <Chip tone="var(--loki-positive)">{flash}</Chip>}
        </>
      }
    />
  );
}

/**
 * An outside card's moves as the ActionBar, in the reply box's row as OutsideMoves sits today (plan 097, U8): read
 * named on Slack and Jira and archive on a mail, the rest before it with Flow's keys (KTD9). A Jira ticket's link to
 * its page is the bar's "open in jira".
 */
export function OutsideItemActions({
  facts,
  thread,
  typing,
  moves,
  onHandoff,
  picking,
}: {
  facts: OutsideFacts;
  thread: ThreadState;
  typing: boolean;
  moves: OutsideMoveHandlers;
  onHandoff?: () => void;
  picking: boolean;
}) {
  const { link } = readHead(thread);
  const view = outsideItem({ facts, messages: [], unread: false });
  const address = ticketAddress(facts, link);
  const off = !!facts.disconnected || picking;
  const archiveTitle = ARCHIVE_TITLE[facts.provider];
  const verbs: Partial<Record<ItemVerb, VerbControl>> = {
    mark_read: { run: moves.read, keys: deckKey("inbox.next", typing), title: READ_TITLE[facts.provider] },
    later: { run: moves.later, keys: deckKey("inbox.later", typing), title: LATER_TITLE[facts.provider] },
  };
  if (archiveTitle) verbs.archive = { run: moves.archive, keys: deckKey("inbox.archive", typing), title: archiveTitle };
  if (facts.provider === "gmail")
    verbs.label = {
      run: moves.label,
      keys: typing ? undefined : keyFor("inbox.label"),
      disabled: off,
      title: "add a Gmail label to the thread; the card stays",
    };
  if (onHandoff)
    verbs.handoff = {
      run: onHandoff,
      disabled: off,
      title: facts.disconnected
        ? `cannot hand off now: ${disconnectedText(facts.disconnected, facts.provider)}`
        : HANDOFF_TITLE[facts.provider](facts.owner_name ?? "its agent"),
    };
  if (address) verbs.open_out = { run: () => openExternal(address), title: address };
  return <ActionBar view={view.actions} verbs={verbs} />;
}

/** The header's second line: where or who, when, the account when more than one is connected, and the last move. */
function OutsideHeadLine({ facts, what, went, cameBack }: { facts: OutsideFacts; what: string | null; went: string | null; cameBack: boolean }) {
  return (
    <>
      {what && (
        <span className="loki-card-head-what" title={what}>
          {what}
        </span>
      )}
      <Meta>{ago(facts.newest_at)}</Meta>
      {/* Said as where it came in, so a mailbox's address never reads as the sender's (plan 078). */}
      {facts.only_account !== true && <Meta title={CAME_FROM[facts.provider]}>in {facts.account_label}</Meta>}
      {went && <Meta>{went}</Meta>}
      {cameBack && <Meta>back · new since you moved on</Meta>}
    </>
  );
}

/** The deck's moves on an outside card: read (⌘]), later (⌘[), archive (⌘E, not on a Jira card) and, on an email card, label (L). */
export interface OutsideMoveHandlers {
  read: () => void;
  later: () => void;
  archive: () => void;
  label: () => void;
}

/** Hand off, label, archive, later and read: they share the reply's row, so the card has one bar of buttons. */
function OutsideMoves({
  facts,
  typing,
  moves,
  onHandoff,
  picking,
}: {
  facts: OutsideFacts;
  typing: boolean;
  moves: OutsideMoveHandlers;
  onHandoff?: () => void;
  picking: boolean;
}) {
  const gmail = facts.provider === "gmail";
  const archiveTitle = ARCHIVE_TITLE[facts.provider];
  return (
    <>
      {onHandoff && (
        <Button
          size="sm"
          onClick={onHandoff}
          disabled={!!facts.disconnected || picking}
          title={
            facts.disconnected
              ? `cannot hand off now: ${disconnectedText(facts.disconnected, facts.provider)}`
              : HANDOFF_TITLE[facts.provider](facts.owner_name ?? "its agent")
          }
        >
          hand off
        </Button>
      )}
      {gmail && (
        <Button
          size="sm"
          onClick={moves.label}
          disabled={!!facts.disconnected || picking}
          title="add a Gmail label to the thread; the card stays"
          kbd={typing ? undefined : keyFor("inbox.label")}
        >
          label
        </Button>
      )}
      {archiveTitle && (
        <Button size="sm" onClick={moves.archive} title={archiveTitle} kbd={deckKey("inbox.archive", typing)}>
          archive
        </Button>
      )}
      <span style={{ flex: 1 }} />
      <Button size="sm" onClick={moves.later} title={LATER_TITLE[facts.provider]} kbd={deckKey("inbox.later", typing)}>
        later
      </Button>
      <Button size="sm" tone="paper" onClick={moves.read} title={READ_TITLE[facts.provider]} kbd={deckKey("inbox.next", typing)}>
        read
      </Button>
    </>
  );
}

/** What the header takes from the read: a Jira ticket's address and, from a Mac on plan 089, the ticket itself. */
const readHead = (thread: ThreadState): { link: string | null; ticket: JiraCardTicket | null } =>
  thread.kind === "read" ? { link: thread.link ?? null, ticket: thread.ticket ?? null } : { link: null, ticket: null };

/** The addresses a mail card's account sends from, so its own mails read as the person's; none for Slack. */
function ownAddresses(facts: OutsideFacts, compose: MailCompose | null): string[] {
  if (facts.provider !== "gmail") return [];
  return [facts.account_id.replace(/^gmail:/, ""), ...(compose?.from.map((f) => f.address) ?? [])];
}

/** The reply box the deck holds on a desktop card: with the card's moves, its people to mention and its opened thread. */
function DeckReply({
  current,
  facts,
  thread,
  source,
  box,
  replyRef,
  onTyping,
  onEscapeEmpty,
  row,
  compose,
  items = false,
}: {
  items?: boolean;
  current: AttentionItem;
  facts: OutsideFacts;
  thread: ThreadState;
  source: OutsideThreadSource | null;
  box: ReplyBoxControl;
  replyRef?: RefObject<HTMLTextAreaElement | null>;
  onTyping?: (typing: boolean) => void;
  onEscapeEmpty?: () => void;
  row: ReactNode;
  compose: MailCompose | null;
}) {
  const people = source?.searchPeople;
  return (
    <OutsideReply
      facts={facts}
      box={box}
      inputRef={replyRef}
      onTyping={onTyping}
      onEscapeEmpty={onEscapeEmpty}
      actions={row}
      compose={compose}
      quote={quoteOf(facts, thread)}
      searchPeople={people ? (q: string) => people(current, q).then((r) => (typeof r === "string" ? [] : r)) : undefined}
      inThread={thread.kind === "read" && !!thread.opened}
      items={items}
    />
  );
}

/**
 * The desktop card for an outside thread: the header (who, where and when, and the badge's flash), the whole thread,
 * the reply box, and the deck's moves. Read marks the thread read out there, later keeps it unread and brings it back,
 * archive archives it in its account, label adds a Gmail label; hand off opens `picker`, where the thread goes to its
 * account's agent (U8), and is off while the account is disconnected. The return-time and label pickers open there too.
 */
export function OutsideCard({
  current,
  facts,
  flash,
  cameBack,
  typing,
  moves,
  went = null,
  onHandoff,
  picker = null,
  source = null,
  box,
  replyRef,
  onTyping,
  onEscapeEmpty,
  compose = null,
}: {
  current: AttentionItem;
  facts: OutsideFacts;
  flash: string | null;
  cameBack: boolean;
  typing: boolean;
  moves: OutsideMoveHandlers;
  /** The chat the thread went to before, in words (`wentTo`). */
  went?: string | null;
  /** Open the hand-off picker; absent, the card has no hand off. */
  onHandoff?: () => void;
  /** The picker open on the card, the hand-off's, the return time's or the labels'. */
  picker?: ReactNode;
  /** Reading the thread, reacting on a Slack card (plan 079) and its people to mention (plan 082); absent, the card shows its last lines. */
  source?: OutsideThreadSource | null;
  /** The reply box, as the deck holds it; absent, the card has no reply box. */
  box?: ReplyBoxControl;
  replyRef?: RefObject<HTMLTextAreaElement | null>;
  onTyping?: (typing: boolean) => void;
  onEscapeEmpty?: () => void;
  /** What a mail card's recipients line starts from (plan 076), as the deck read it. */
  compose?: MailCompose | null;
}) {
  const thread = useOutsideThread(current, source, box?.onThread ? { opened: box.thread ?? null, setOpened: box.onThread } : undefined);
  // The new chat pane's preview draws the thread's messages with the item components (plan 097, U7).
  const [preview] = useThreadPreview();
  // With the preview on, the card's moves are the item's ActionBar (plan 097, U8), in the same place under the reply.
  const row =
    preview === "on" ? (
      <OutsideItemActions facts={facts} thread={thread} typing={typing} moves={moves} onHandoff={onHandoff} picking={!!picker} />
    ) : (
      <OutsideMoves facts={facts} typing={typing} moves={moves} onHandoff={onHandoff} picking={!!picker} />
    );
  // A mail's reply is a box at the end of its thread, as Gmail's is (plan 078); the card's moves keep the bottom row.
  const mailBox = facts.provider === "gmail" && !!box;
  const own = ownAddresses(facts, compose);
  const reply = box ? (
    <DeckReply
      current={current}
      facts={facts}
      thread={thread}
      source={source}
      box={box}
      replyRef={replyRef}
      onTyping={onTyping}
      onEscapeEmpty={onEscapeEmpty}
      row={row}
      compose={compose}
      items={preview === "on"}
    />
  ) : null;
  return (
    <div style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>
      {preview === "on" ? (
        <OutsideItemHeader facts={facts} unread={current.unread} flash={flash} went={went} cameBack={cameBack} thread={thread} />
      ) : (
        <OutsideHeader facts={facts} badge={flash ?? (current.unread ? "new" : null)} went={went} cameBack={cameBack} {...readHead(thread)} />
      )}
      <div data-thread-scroll style={{ flex: 1, minHeight: 0, overflow: "auto", padding: facts.provider === "slack" ? "8px 20px 16px" : "16px 18px" }}>
        {facts.disconnected && (
          <Meta negative wrap style={{ display: "block", marginBottom: 12 }}>
            {disconnectedText(facts.disconnected, facts.provider)}
          </Meta>
        )}
        <OutsideThread facts={facts} state={thread} own={own} items={preview === "on"} />
        {mailBox && <div style={{ marginLeft: MAIL_INDENT, marginTop: 16 }}>{reply}</div>}
      </div>
      {picker && <div style={{ padding: "10px 18px", borderTop: "1px solid var(--loki-border)" }}>{picker}</div>}
      <div style={{ padding: "10px 18px", borderTop: "1px solid var(--loki-border)" }}>
        {reply && !mailBox ? reply : <div style={{ display: "flex", alignItems: "center", gap: 8 }}>{row}</div>}
      </div>
    </div>
  );
}
