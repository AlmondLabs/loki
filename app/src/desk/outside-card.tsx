import type {
  AccountDisconnectCause,
  AccountProvider,
  EmojiChoice,
  SlackPerson,
  MailAddressing,
  MailCompose,
  OutsideFacts,
  OutsideMessage,
  OutsideWindow,
  OutsideWindowAsk,
} from "../../../core/frame-types.ts";
import { Fragment, useEffect, useEffectEvent, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode, type RefObject } from "react";
import type { AttentionItem } from "../../../core/attention/model.ts";
import type { OutsideSource } from "../../../core/attention/use-attention.ts";
import { Button, Chip, Meta, TextArea } from "../components";
import { KEYMAP, chordIds, cmdHeld, formatKeys, keyFor, type Platform } from "../shell/keymap";
import { keyboard } from "./env";
import { scrollWithin } from "../shared/scroll-within";
import { ago, deckKey } from "./catch-up-parts";
import { CardFace, CardHead, ReachTag, type CardMark } from "./card-head";
import { openExternal } from "./env";
import { LinkedText, MailHtml } from "./mail-html";
import { MailAddressLine, addressOf, asRecipient, startAddressing, suggest } from "./mail-address";
import { useMentions, type MentionSource } from "./mentions";
import { MAIL_INDENT, MailThread, firstLine, senderName } from "./mail-thread";
import { NewLine, SlackThread, loadLabel } from "./slack-thread";
import { toggleReaction } from "./slack-reactions";

/**
 * An outside card (plan 067, U3): a Gmail or Slack thread or a Jira ticket in the Inbox, not a chat. It shows who wrote, about what,
 * which account and agent it belongs to (R10), and the whole thread read from its account (plan 068), with a box for
 * the person's own reply. It is never a Conversation: the reply goes to the thread, not to an agent. The phone draws
 * the same thread with `OutsideThread`.
 */

const SERVICE: Record<AccountProvider, string> = { gmail: "Gmail", slack: "Slack", jira: "Jira" };

/** What a disconnected account's cards say (R22): what happened and how to reconnect, lowercase as desktop meta. */
export function disconnectedText(cause: AccountDisconnectCause, provider: AccountProvider): string {
  const service = SERVICE[provider];
  const where = "Preferences › Accounts";
  switch (cause) {
    case "sign_in_again":
      // A Jira site is connected with an API token the person makes, so there is no sign-in to make again.
      return `${service} wants a new ${provider === "jira" ? "API token" : "sign-in"}: ${where}`;
    case "admin_blocks":
      return `a workspace admin blocks loki in ${service}: ask them, then connect again in ${where}`;
    case "slack_signed_out":
      return `the Slack app signed out: sign in there, then connect again in ${where}`;
    case "temporarily_failing":
      return `${service} keeps failing for now: loki tries again on its own`;
  }
}

/** The account and its owner, as the card names them: "ada@acme.com · Gmail · Work". */
export function outsideWho(o: OutsideFacts): string {
  return [o.account_label, SERVICE[o.provider], o.owner_name ?? "its agent"].join(" · ");
}

/** The thread's last messages, one paragraph each, as plain text; the phone draws the same inside its card. */
export function OutsideLines({ facts, touch = false }: { facts: OutsideFacts; touch?: boolean }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: touch ? "var(--phone-space-3)" : 12 }}>
      {facts.lines.map((line, i) => (
        <p key={i} style={{ margin: 0, whiteSpace: "pre-wrap", overflowWrap: "anywhere", fontSize: touch ? "var(--phone-text-body)" : 13.5 }}>
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

/**
 * The card's title: a mail's subject; for Slack, who wrote, since a Slack message has no subject of its own; for Jira,
 * the ticket's key and title.
 */
export function outsideTitle(o: OutsideFacts): string {
  switch (o.provider) {
    case "gmail":
      return o.subject || "no subject";
    case "slack":
      return senderName(o.sender);
    case "jira":
      return ticketLine(o);
  }
}

/** A Jira ticket as its card names it: "OPS-7 · Rotate the keys". */
export function ticketLine(o: Pick<OutsideFacts, "place" | "subject">): string {
  return [o.place, o.subject].filter(Boolean).join(" · ");
}

/**
 * A Jira ticket's address in the browser (R14): as its site's Mac read it, on the site's own domain, else on the
 * account's host until the read comes back; null for mail and Slack.
 */
export function ticketAddress(o: OutsideFacts, link: string | null = null): string | null {
  if (o.provider !== "jira") return null;
  return link ?? (o.place ? `https://${o.account_label}/browse/${encodeURIComponent(o.place)}` : null);
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
}

/** What a card's thread is read from, and, for a Slack card, what reacts on it (plan 079). */
export type OutsideThreadSource = Pick<OutsideSource, "readOutside" | "reactOutside" | "searchEmoji" | "searchPeople">;

/**
 * What a card's thread is read and reacted through, taken from everything the Inbox holds; null when it cannot read
 * threads. Each is passed on, so a card offers reacting (plan 079) and mentioning (plan 082) wherever its source can.
 */
export function threadSourceOf(chats: Partial<OutsideThreadSource>): OutsideThreadSource | null {
  const { readOutside, reactOutside, searchEmoji, searchPeople } = chats;
  if (!readOutside) return null;
  return {
    readOutside,
    ...(reactOutside ? { reactOutside } : {}),
    ...(searchEmoji ? { searchEmoji } : {}),
    ...(searchPeople ? { searchPeople } : {}),
  };
}

/** Where a thread stands on the card: read from its account, still being read, or why it could not be. */
export type ThreadState =
  | { kind: "loading" }
  | { kind: "read"; messages: OutsideMessage[]; window?: OutsideWindow | null; controls?: ThreadControls; link?: string | null }
  | { kind: "failed"; message: string };

/** What the card is showing: for which card and view, and what came back, with any load in flight. */
interface Shown {
  /** The card and view it was read for, and the read itself, which a newer message makes again. */
  view: string;
  tag: string;
  messages: OutsideMessage[];
  window: OutsideWindow | null;
  busy: "before" | "after" | null;
  failed: string | null;
  /** A Jira ticket's address, as the read gave it. */
  link: string | null;
}

/** The first message after a thread's pinned first message, which "load earlier" loads before. */
const firstLoaded = (messages: readonly OutsideMessage[], w: OutsideWindow) =>
  (w.view === "thread" ? messages.find((m) => m.id !== w.thread_ts) : messages[0])?.id ?? null;

/**
 * Whether a card reads its thread again after the person's own send (plan 2026-11-10-1451, U7): the newest event of a
 * Jira card does not change for the person's own comment, so nothing else would show it there; mail and Slack cards
 * keep reading again only on a newer message.
 */
const READS_AFTER_SEND: Record<AccountProvider, boolean> = { gmail: false, slack: false, jira: true };

/**
 * The card's thread (plan 068), read from its account when the card comes up and again when a new message arrives in
 * it, or for a Jira card when `sent`, the count of the person's sends from it, goes up; without a source (a demo, an
 * old daemon) it stays loading and the card shows its last lines. A Slack card's window (plan 077) loads more on either
 * side and opens a post's thread; what was loaded is dropped when the card or its newest message changes (R15).
 */
export function useOutsideThread(item: AttentionItem, source: OutsideThreadSource | null, sent = 0): ThreadState {
  const o = item.outside;
  const key = o ? `${o.account_id}/${o.thread_id}/${o.newest_message_id}` : "";
  // The thread the person opened from the channel view, for this card only; another card starts on its own view.
  const [opened, setOpened] = useState<{ key: string; threadTs: string } | null>(null);
  const threadTs = opened?.key === key ? opened.threadTs : null;
  const ask: OutsideWindowAsk = threadTs ? { view: "thread", thread_ts: threadTs } : {};
  const view = o ? `${o.account_id}/${o.thread_id}/${threadTs ?? ""}` : "";
  // Read again after a send where the card asks for it, keeping what it shows meanwhile, as for a newer message.
  const again = o && READS_AFTER_SEND[o.provider] ? sent : 0;
  const tag = `${key}/${threadTs ?? ""}/${again}`;
  const [shown, setShown] = useState<Shown | null>(null);
  // The item changes identity on every list update; the thread is read again only when its newest message does.
  const read = useEffectEvent((more: OutsideWindowAsk) => source?.readOutside(item, { ...ask, ...more }) ?? null);
  useEffect(() => {
    if (!key) return;
    let live = true;
    void read({})?.then((out) => {
      if (!live) return;
      setShown(
        typeof out === "string"
          ? { view, tag, messages: [], window: null, busy: null, failed: out, link: null }
          : { view, tag, messages: out.messages, window: out.window, busy: null, failed: null, link: out.link ?? null },
      );
    });
    return () => {
      live = false;
    };
  }, [key, tag, view]);
  // A newer message reads the thread again; meanwhile the card keeps what it shows.
  if (!key || shown?.view !== view) return { kind: "loading" };
  if (shown.failed !== null) return { kind: "failed", message: shown.failed };
  const w = shown.window;
  if (!w) return { kind: "read", messages: shown.messages, link: shown.link };
  const load = (direction: "before" | "after") => {
    if (shown.busy) return;
    const from = direction === "before" ? firstLoaded(shown.messages, w) : (shown.messages.at(-1)?.id ?? null);
    if (!from) return;
    setShown({ ...shown, busy: direction });
    void source?.readOutside(item, { ...ask, direction, from }).then((out) =>
      setShown((now) => {
        if (now?.tag !== tag) return now;
        if (typeof out === "string") return { ...now, busy: null };
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
      }),
    );
  };
  // A reaction shows at once on what the card holds; a refusal puts the message's pills back as they were.
  const setReactions = (messageId: string, change: (m: OutsideMessage) => OutsideMessage["reactions"]) =>
    setShown((now) => (now?.tag === tag ? { ...now, messages: now.messages.map((m) => (m.id === messageId ? { ...m, reactions: change(m) } : m)) } : now));
  const reactOutside = source?.reactOutside;
  const react = (messageId: string, choice: EmojiChoice, on: boolean) => {
    if (!reactOutside) return;
    setReactions(messageId, (m) => toggleReaction(m.reactions ?? [], choice, on));
    void reactOutside(item, messageId, choice.name, on).then((refused) => {
      if (refused !== null) setReactions(messageId, (m) => toggleReaction(m.reactions ?? [], choice, !on));
    });
  };
  const search = source?.searchEmoji;
  const controls: ThreadControls = {
    load,
    openThread: (ts) => setOpened({ key, threadTs: ts }),
    ...(threadTs ? { back: () => setOpened(null) } : {}),
    busy: shown.busy,
    ...(reactOutside ? { react } : {}),
    ...(search ? { searchEmoji: (q: string) => search(item, q).then((r) => (typeof r === "string" ? [] : r)) } : {}),
  };
  return { kind: "read", messages: shown.messages, window: w, controls, link: shown.link };
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
function MessageRow({ m, touch, folded }: { m: OutsideMessage; touch: boolean; folded: boolean }) {
  // Only the press is kept; whether it is folded is the thread's to say, so a mail a newer one arrives under folds.
  const [opened, setOpened] = useState(false);
  const open = !folded || opened;
  const size = touch ? "var(--phone-text-body)" : 13.5;
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
}: {
  facts: OutsideFacts;
  state: ThreadState;
  touch?: boolean;
  /** The person's own addresses, which a mail's header line says as "you" (plan 078). */
  own?: readonly string[];
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
  const gap = touch ? "var(--phone-space-4)" : 16;
  if (state.kind !== "read" || state.messages.length === 0)
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: touch ? "var(--phone-space-3)" : 12 }}>
        <Meta wrap negative={state.kind === "failed"}>
          {state.kind === "failed" ? `could not read the whole thread: ${state.message}` : "reading the whole thread…"}
        </Meta>
        <OutsideLines facts={facts} touch={touch} />
      </div>
    );
  if (facts.provider === "slack" && !touch)
    return <SlackThread messages={state.messages} newest={facts.newest_message_id} window={state.window ?? null} controls={state.controls ?? null} />;
  if (facts.provider === "gmail" && !touch)
    return (
      <>
        <MailThread messages={state.messages} own={own} />
        <div ref={end} />
      </>
    );
  // A Jira card draws the New line before its first unread event, and loads earlier events (KTD14); the phone's Slack
  // and mail cards keep the plain list they had.
  const jira = facts.provider === "jira";
  const newAt = jira ? state.messages.findIndex((m) => m.unread === true) : -1;
  const { window: w, controls } = state;
  const earlier = jira && w && controls && w.more_before !== false && w.more_before !== 0 ? controls : null;
  const earlierLabel = earlier ? loadLabel("before", true, earlier.busy === "before") : "";
  return (
    <div style={{ display: "flex", flexDirection: "column", gap }}>
      {earlier && (
        <Button size={touch ? "touch" : "sm"} bare disabled={earlier.busy !== null} onClick={() => earlier.load("before")} style={{ alignSelf: "center" }}>
          {touch ? `${earlierLabel[0].toUpperCase()}${earlierLabel.slice(1)}` : earlierLabel}
        </Button>
      )}
      {state.messages.map((m, i) => (
        <Fragment key={m.id}>
          {i === newAt && <NewLine />}
          <MessageRow m={m} touch={touch} folded={facts.provider === "gmail" && i < state.messages.length - 1} />
        </Fragment>
      ))}
      <div ref={end} />
    </div>
  );
}

/** Where the person's reply goes, in words: reply-all in a mail thread, the DM or a Slack thread, or a comment on the ticket. */
export function replyPlace(o: OutsideFacts): string {
  switch (o.provider) {
    case "gmail":
      return "reply to all";
    case "slack":
      return o.thread_id.includes(":") ? "reply in the thread" : "reply in the DM";
    case "jira":
      return "comment on the ticket";
  }
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
}

/** What the desktop's send button says it does, for each service: a Jira comment leaves the card unread (KTD11). */
const SEND_TITLE: Record<AccountProvider, string> = {
  gmail: "send it as you; the card stays for your next move",
  slack: "send it as you; the card stays for your next move",
  jira: "post it on the ticket as you; the card stays, unread, for your next move",
};

/** The line under the phone's send, for each service. */
const SEND_NOTE: Record<AccountProvider, string> = {
  gmail: "Waits 10 seconds so you can undo, then archives the card.",
  slack: "Sends as you, then archives the card.",
  jira: "Posts on the ticket as you. The card stays until you read it.",
};

/**
 * The reply box under the thread (plan 068): the person's own words, sent in the thread as they wrote them. On the
 * desktop the deck holds the text (`box`), so ⌘], ⌘[ and ⌘E send it with their move and Enter sends it alone (plan 083); the
 * phone's box keeps its own and sends with `onSend`. Shift-Enter starts a line; Esc hands the deck's keys back, or
 * closes the deck when the box is empty. A send that fails keeps the text and says why.
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
  searchPeople,
}: {
  facts: OutsideFacts;
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
  const [ownText, setOwnText] = useState("");
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
  const hint = !isMail ? replyPlace(facts) : shown?.mode === "forward" ? "add a note" : compose ? "reply" : replyPlace(facts);
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

/** The mark on a card's face for where it came from. */
const MARK: Record<AccountProvider, CardMark> = { gmail: "mail", slack: "slack", jira: "jira" };

/** What the header's second line names first: a mail's sender, a Slack channel or DM, or a Jira ticket's key and title. */
function headWhat(facts: OutsideFacts): string | null {
  switch (facts.provider) {
    case "gmail":
      return senderName(facts.sender);
    case "slack":
      return facts.place ?? (facts.reach === "dm" ? "direct message" : null);
    case "jira":
      return ticketLine(facts) || null;
  }
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
}: {
  facts: OutsideFacts;
  badge: string | null;
  went: string | null;
  cameBack: boolean;
  /** A Jira ticket's address as the read gave it; until then the account's host stands in. */
  link?: string | null;
}) {
  const who = senderName(facts.sender);
  const mail = facts.provider === "gmail";
  const address = ticketAddress(facts, link);
  return (
    <CardHead
      face={<CardFace name={who} src={facts.sender_avatar ?? null} mark={MARK[facts.provider]} />}
      // A mail card is titled by its subject, as Gmail's thread view is (plan 078); each mail then names who wrote it.
      who={mail ? facts.subject || "no subject" : who}
      whoHint={facts.sender_address ? `${who} <${facts.sender_address}>` : undefined}
      line={<OutsideHeadLine facts={facts} what={headWhat(facts)} went={went} cameBack={cameBack} />}
      right={
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
      }
    />
  );
}

/** Where a card came from, as the header says it when more than one account of its service is connected. */
const CAME_FROM: Record<AccountProvider, string> = { gmail: "the mailbox it came to", slack: "the workspace it came from", jira: "the site it came from" };

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

/** What later says it does, for each service: Jira keeps no read mark, so nothing changes there (R20). */
const LATER_TITLE: Record<AccountProvider, string> = {
  gmail: "keep it unread in Gmail: the card comes back in a day, or sooner if something new arrives",
  slack: "keep it unread in Slack: the card comes back in a day, or sooner if something new arrives",
  jira: "keep it unread: the card comes back in a day, or sooner if the ticket changes",
};

/** What read says it does, for each service. */
const READ_TITLE: Record<AccountProvider, string> = {
  gmail: "mark it read in Gmail: the card rests and comes back later",
  slack: "mark it read in Slack: the card ends until someone writes again",
  jira: "done reading: the card ends until the ticket changes again; nothing changes in Jira",
};

/**
 * What archive says it does, for each service; null where there is no archive: a Jira card ends only with read, so it
 * draws none (KTD12).
 */
const ARCHIVE_TITLE: Record<AccountProvider, string | null> = {
  gmail: "done with this thread: it leaves the Inbox and is archived in Gmail",
  slack: "done with this thread: it leaves the Inbox and is marked read in Slack",
  jira: null,
};

/** What hand off says it does, for each service: a mail or a Slack card leaves with it, and a Jira card stays (KTD13). */
const HANDOFF_TITLE: Record<AccountProvider, (owner: string) => string> = {
  gmail: (owner) => `give the whole thread to ${owner} in one of its chats; the card leaves until someone writes again`,
  slack: (owner) => `give the whole thread to ${owner} in one of its chats; the card leaves until someone writes again`,
  jira: (owner) => `give the whole ticket to ${owner} in one of its chats; the card stays until you read it`,
};

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
  sent = 0,
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
  /** How many of the person's sends went this visit, so a Jira card reads its ticket again to show their comment. */
  sent?: number;
}) {
  const thread = useOutsideThread(current, source, sent);
  const people = source?.searchPeople;
  const peopleSearch = people ? (q: string) => people(current, q).then((r) => (typeof r === "string" ? [] : r)) : undefined;
  const row = <OutsideMoves facts={facts} typing={typing} moves={moves} onHandoff={onHandoff} picking={!!picker} />;
  // A mail's reply is a box at the end of its thread, as Gmail's is (plan 078); the card's moves keep the bottom row.
  const mailBox = facts.provider === "gmail" && !!box;
  const own = facts.provider === "gmail" ? [facts.account_id.replace(/^gmail:/, ""), ...(compose?.from.map((f) => f.address) ?? [])] : [];
  const reply = box ? (
    <OutsideReply
      facts={facts}
      box={box}
      inputRef={replyRef}
      onTyping={onTyping}
      onEscapeEmpty={onEscapeEmpty}
      actions={row}
      compose={compose}
      quote={quoteOf(facts, thread)}
      searchPeople={peopleSearch}
    />
  ) : null;
  return (
    <div style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>
      <OutsideHeader
        facts={facts}
        badge={flash ?? (current.unread ? "new" : null)}
        went={went}
        cameBack={cameBack}
        link={thread.kind === "read" ? (thread.link ?? null) : null}
      />
      <div data-thread-scroll style={{ flex: 1, minHeight: 0, overflow: "auto", padding: facts.provider === "slack" ? "8px 20px 16px" : "16px 18px" }}>
        {facts.disconnected && (
          <Meta negative wrap style={{ display: "block", marginBottom: 12 }}>
            {disconnectedText(facts.disconnected, facts.provider)}
          </Meta>
        )}
        <OutsideThread facts={facts} state={thread} own={own} />
        {mailBox && <div style={{ marginLeft: MAIL_INDENT, marginTop: 16 }}>{reply}</div>}
      </div>
      {picker && <div style={{ padding: "10px 18px", borderTop: "1px solid var(--loki-border)" }}>{picker}</div>}
      <div style={{ padding: "10px 18px", borderTop: "1px solid var(--loki-border)" }}>
        {reply && !mailBox ? reply : <div style={{ display: "flex", alignItems: "center", gap: 8 }}>{row}</div>}
      </div>
    </div>
  );
}
