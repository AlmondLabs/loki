import type { AccountDisconnectCause, AccountProvider, MailAddressing, MailCompose, OutsideFacts, OutsideMessage } from "../../../core/frame-types.ts";
import { useEffect, useEffectEvent, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode, type RefObject } from "react";
import type { AttentionItem } from "../../../core/attention/model.ts";
import type { OutsideSource } from "../../../core/attention/use-attention.ts";
import { Button, Chip, Meta, TextArea } from "../components";
import { KEYMAP, chordIds, cmdHeld, formatKeys, keyFor, type Platform } from "../shell/keymap";
import { keyboard } from "./env";
import { scrollWithin } from "../shared/scroll-within";
import { ago, deckKey } from "./catch-up-parts";
import { CardFace, CardHead, ReachTag } from "./card-head";
import { LinkedText, MailHtml } from "./mail-html";
import { MailAddressLine, startAddressing } from "./mail-address";
import { SlackThread } from "./slack-thread";

/**
 * An outside card (plan 067, U3): a Gmail or Slack thread in the Inbox, not a chat. It shows who wrote, about what,
 * which account and agent it belongs to (R10), and the whole thread read from its account (plan 068), with a box for
 * the person's own reply. It is never a Conversation: the reply goes to the thread, not to an agent. The phone draws
 * the same thread with `OutsideThread`.
 */

const SERVICE: Record<AccountProvider, string> = { gmail: "Gmail", slack: "Slack" };

/** What a disconnected account's cards say (R22): what happened and how to reconnect, lowercase as desktop meta. */
export function disconnectedText(cause: AccountDisconnectCause, provider: AccountProvider): string {
  const service = SERVICE[provider];
  const where = "Preferences › Accounts";
  switch (cause) {
    case "sign_in_again":
      return `${service} wants a new sign-in: ${where}`;
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

/** A sender as the card names them: a mail address's display name ("Ada" from "Ada <ada@acme.com>"), else as given. */
export function senderName(sender: string): string {
  const name = sender
    .replace(/<[^>]*>/g, "")
    .replace(/^"|"$/g, "")
    .replace(/"/g, "")
    .trim();
  return name || sender.replace(/[<>]/g, "").trim() || "someone";
}

/** The card's title: a mail's subject, or for Slack, who wrote, since a Slack message has no subject of its own. */
export function outsideTitle(o: OutsideFacts): string {
  return o.provider === "gmail" ? o.subject || "no subject" : senderName(o.sender);
}

/** Where a thread stands on the card: read from its account, still being read, or why it could not be. */
export type ThreadState = { kind: "loading" } | { kind: "read"; messages: OutsideMessage[] } | { kind: "failed"; message: string };

/**
 * The card's whole thread (plan 068), read from its account when the card comes up and again when a new message
 * arrives in it; without a source (a demo, an old daemon) it stays loading and the card shows its last lines.
 */
export function useOutsideThread(item: AttentionItem, source: Pick<OutsideSource, "readOutside"> | null): ThreadState {
  const [state, setState] = useState<ThreadState>({ kind: "loading" });
  const o = item.outside;
  const key = o ? `${o.account_id}/${o.thread_id}/${o.newest_message_id}` : "";
  // The item changes identity on every list update; the thread is read again only when its newest message does.
  const read = useEffectEvent(() => source?.readOutside(item) ?? null);
  useEffect(() => {
    if (!key) return;
    let live = true;
    void read()?.then((out) => {
      if (live) setState(typeof out === "string" ? { kind: "failed", message: out } : { kind: "read", messages: out });
    });
    return () => {
      live = false;
    };
  }, [key]);
  return state;
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

/** A message's first line with words in it, for a folded mail. */
export function firstLine(text: string): string {
  return (
    text
      .split("\n")
      .find((l) => l.trim() !== "")
      ?.trim() ?? ""
  );
}

/**
 * The thread on the card: every message, oldest first, scrolled to the newest. While it is read, or when it could not
 * be, the card's own last lines stand in, with a line saying so.
 */
export function OutsideThread({ facts, state, touch = false }: { facts: OutsideFacts; state: ThreadState; touch?: boolean }) {
  const end = useRef<HTMLDivElement>(null);
  const count = state.kind === "read" ? state.messages.length : 0;
  useEffect(() => {
    const el = end.current;
    if (!count || !el) return;
    const box = el.closest<HTMLElement>("[data-thread-scroll]");
    if (box) scrollWithin(box, el, "end");
    else el.scrollIntoView({ block: "end" }); // the phone's card scrolls with its page
  }, [count]);
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
  if (facts.provider === "slack" && !touch) return <SlackThread messages={state.messages} newest={facts.newest_message_id} />;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap }}>
      {state.messages.map((m, i) => (
        <MessageRow key={m.id} m={m} touch={touch} folded={facts.provider === "gmail" && i < state.messages.length - 1} />
      ))}
      <div ref={end} />
    </div>
  );
}

/** Where the person's reply goes, in words: reply-all in a mail thread, the DM, or a Slack thread. */
export function replyPlace(o: OutsideFacts): string {
  if (o.provider === "gmail") return "reply to all";
  return o.thread_id.includes(":") ? "reply in the thread" : "reply in the DM";
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

/**
 * The reply box under the thread (plan 068): the person's own words, sent in the thread as they wrote them. On the
 * desktop the deck holds the text (`box`), so ⌘], ⌘[ and ⌘E send it with their move and Enter sends it with read; the
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
}: {
  facts: OutsideFacts;
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
  /** The card's other moves, drawn on the row after send, so the card has one bar of buttons. */
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
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: touch ? "var(--phone-space-2)" : 8 }}>
      {isMail && (
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
      )}
      <TextArea
        ref={inputRef}
        size={touch ? "touch" : "sm"}
        value={text}
        rows={touch ? 4 : 3}
        disabled={off}
        placeholder={touch ? `${hint[0].toUpperCase()}${hint.slice(1)}` : hint}
        aria-label={hint}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={keys}
        onFocus={() => onTyping?.(true)}
        onBlur={() => onTyping?.(false)}
      />
      {isMail && compose && (hasSignature || quote) && (
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
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
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <Button
          size={touch ? "touch" : "sm"}
          tone="positive"
          disabled={off || !text.trim()}
          onClick={() => void send()}
          kbd={touch ? undefined : sendKey ? formatKeys(sendKey) : keyFor("chat.send")}
          title={touch ? "send it as you, then archive the card" : nobody ? "add someone to send it to first" : "send it as you, and the card is read"}
        >
          {busy ? (touch ? "Sending…" : "sending…") : touch ? "Send" : "send"}
        </Button>
        {touch && busy && onUndo && (
          <Button size="touch" onClick={onUndo}>
            Undo
          </Button>
        )}
        {touch && !error && !busy && (
          <Meta wrap>{isMail ? "Waits 10 seconds so you can undo, then archives the card." : "Sends as you, then archives the card."}</Meta>
        )}
        {actions}
      </div>
      {error && (
        <Meta negative wrap>
          {error}
        </Meta>
      )}
    </div>
  );
}

/**
 * The card's header (plan 073): the sender's face with the mark of Slack or mail, who wrote, then where (a Slack
 * channel) or what (a mail's subject) and when; the tag for how directly it is meant for the person, and the badge or
 * the last move's flash. The account is named only when more than one of its service is connected.
 */
function OutsideHeader({ facts, badge, went, cameBack }: { facts: OutsideFacts; badge: string | null; went: string | null; cameBack: boolean }) {
  const who = senderName(facts.sender);
  const what = facts.provider === "gmail" ? facts.subject || "no subject" : (facts.place ?? (facts.reach === "dm" ? "direct message" : null));
  return (
    <CardHead
      face={<CardFace name={who} src={facts.sender_avatar ?? null} mark={facts.provider === "gmail" ? "mail" : "slack"} />}
      who={who}
      whoHint={facts.sender_address ? `${who} <${facts.sender_address}>` : undefined}
      line={
        <>
          {what && (
            <span className="loki-card-head-what" title={what}>
              {what}
            </span>
          )}
          {facts.only_account !== true && <Meta>{facts.account_label}</Meta>}
          <Meta>{ago(facts.newest_at)}</Meta>
          {went && <Meta>{went}</Meta>}
          {cameBack && <Meta>back · new since you moved on</Meta>}
        </>
      }
      right={
        <>
          {facts.reach && <ReachTag reach={facts.reach} />}
          {badge && <Chip tone="var(--loki-positive)">{badge}</Chip>}
        </>
      }
    />
  );
}

/** The deck's moves on an outside card: read (⌘]), later (⌘[), archive (⌘E) and, on an email card, label (L). */
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
              : `give the whole thread to ${facts.owner_name ?? "its agent"} in one of its chats; the card leaves until someone writes again`
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
      <Button
        size="sm"
        onClick={moves.archive}
        title={`done with this thread: it leaves the Inbox and is ${gmail ? "archived in Gmail" : "marked read in Slack"}`}
        kbd={deckKey("inbox.archive", typing)}
      >
        archive
      </Button>
      <span style={{ flex: 1 }} />
      <Button
        size="sm"
        onClick={moves.later}
        title={`keep it unread${gmail ? " in Gmail" : " in Slack"}: the card comes back in a day, or sooner if something new arrives`}
        kbd={deckKey("inbox.later", typing)}
      >
        later
      </Button>
      <Button
        size="sm"
        tone="paper"
        onClick={moves.read}
        title={gmail ? "mark it read in Gmail: the card rests and comes back later" : "mark it read in Slack: the card ends until someone writes again"}
        kbd={deckKey("inbox.next", typing)}
      >
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
  /** Reading the thread; absent, the card shows its last lines. */
  source?: Pick<OutsideSource, "readOutside"> | null;
  /** The reply box, as the deck holds it; absent, the card has no reply box. */
  box?: ReplyBoxControl;
  replyRef?: RefObject<HTMLTextAreaElement | null>;
  onTyping?: (typing: boolean) => void;
  onEscapeEmpty?: () => void;
  /** What a mail card's recipients line starts from (plan 076), as the deck read it. */
  compose?: MailCompose | null;
}) {
  const thread = useOutsideThread(current, source);
  const row = <OutsideMoves facts={facts} typing={typing} moves={moves} onHandoff={onHandoff} picking={!!picker} />;
  return (
    <div style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>
      <OutsideHeader facts={facts} badge={flash ?? (current.unread ? "new" : null)} went={went} cameBack={cameBack} />
      <div data-thread-scroll style={{ flex: 1, minHeight: 0, overflow: "auto", padding: facts.provider === "slack" ? "8px 20px 16px" : "16px 18px" }}>
        {facts.disconnected && (
          <Meta negative wrap style={{ display: "block", marginBottom: 12 }}>
            {disconnectedText(facts.disconnected, facts.provider)}
          </Meta>
        )}
        <OutsideThread facts={facts} state={thread} />
      </div>
      {picker && <div style={{ padding: "10px 18px", borderTop: "1px solid var(--loki-border)" }}>{picker}</div>}
      <div style={{ padding: "10px 18px", borderTop: "1px solid var(--loki-border)" }}>
        {box ? (
          <OutsideReply
            facts={facts}
            box={box}
            inputRef={replyRef}
            onTyping={onTyping}
            onEscapeEmpty={onEscapeEmpty}
            actions={row}
            compose={compose}
            quote={quoteOf(facts, thread)}
          />
        ) : (
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>{row}</div>
        )}
      </div>
    </div>
  );
}
