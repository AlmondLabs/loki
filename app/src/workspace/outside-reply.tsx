import { useRef, useState, type ChangeEvent, type KeyboardEvent as ReactKeyboardEvent, type ReactNode, type RefObject, type SyntheticEvent } from "react";
import type { MailAddressing, MailCompose, NotSentReply, OutsideFacts, SlackPerson } from "../../../core/frame-types.ts";
import type { AttentionItem } from "../../../core/attention/model.ts";
import { cn } from "@/lib/utils";
import { Button, Meta, TextArea } from "../components";
import { ItemReplyBox } from "../item/reply-box";
import { KEYMAP, chordIds, cmdHeld, formatKeys, keyFor, type Platform } from "../shell/keymap";
import { keyboard } from "./env";
import { MailAddressLine, addressOf, asRecipient, startAddressing, suggest } from "./mail-address";
import { useMentions, type MentionSource } from "./mentions";
import { firstLine } from "./mail-thread";
import type { OpenedThread } from "./deck-moves";
import { useSeededReply } from "./use-seeded-reply";
import { SEND_NOTE, SEND_TITLE, replyPlace } from "./outside-words";
import { quoteOf, type OutsideThreadSource, type ThreadState } from "./use-outside-thread";

const DECK_CHORDS = new Set(["flow.next", "flow.later", "flow.archive"]);

export function replyBoxKey(e: KeyboardEvent, os: Platform = keyboard, mail = false): "deck" | "send" | "recipients" | "escape" | "own" {
  const ids = chordIds(e, KEYMAP, os);
  if (cmdHeld(e, os) && ids.some((id) => DECK_CHORDS.has(id))) return "deck";
  if (mail) {
    if (!e.isComposing && e.key === "Enter" && cmdHeld(e, os) && !e.shiftKey && !e.altKey) return "send";
    if (cmdHeld(e, os) && e.shiftKey && e.key.toLowerCase() === "c") return "recipients";
  } else if (!e.isComposing && ids.includes("chat.send")) return "send";
  return e.key === "Escape" ? "escape" : "own";
}

export interface ReplyBoxControl {
  text: string;
  mail: MailAddressing | null;
  busy: boolean;
  error: string | null;
  onText: (text: string) => void;
  onMail: (mail: MailAddressing) => void;
  onSend: () => void;
  thread?: OpenedThread | null;
  onThread?: (thread: OpenedThread | null) => void;
}

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
  onPickPerson,
  inThread = false,
  items = false,
  onUnsent,
  folded = false,
}: {
  folded?: boolean;
  inThread?: boolean;
  items?: boolean;
  onUnsent?: (outboxId: string, action: "resend" | "discard") => Promise<string | null>;
  facts: OutsideFacts;
  keep?: string;
  searchPeople?: (query: string) => Promise<SlackPerson[]>;
  onPickPerson?: (person: SlackPerson) => void;
  onSend?: (text: string, mail: MailAddressing | null) => Promise<{ sent: boolean; error: string | null; undone?: true }>;
  compose?: MailCompose | null;
  quote?: string | null;
  onUndo?: () => void;
  box?: ReplyBoxControl;
  actions?: ReactNode;
  inputRef?: RefObject<HTMLTextAreaElement | null>;
  onTyping?: (typing: boolean) => void;
  onEscapeEmpty?: () => void;
  touch?: boolean;
}) {
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
            later: (q) =>
              searchPeople(q).then((people) => ({
                list: people.map((p) => ({ key: p.id, label: p.name, sub: `@${p.handle}`, insert: p.name, onPick: () => onPickPerson?.(p) })),
              })),
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
    } catch (e) {
      setBusy(false);
      throw e;
    }
    setBusy(false);
  };
  const keys = (e: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (mentions.onKeyDown(e)) return;
    const key = replyBoxKey(e.nativeEvent, keyboard, isMail);
    if (key === "deck") return;
    if (key !== "escape") e.stopPropagation();
    if (key === "send") {
      e.preventDefault();
      void send();
    } else if (key === "recipients") {
      e.preventDefault();
      setLineOpen(true);
    } else if (key === "escape") {
      if (!text && onEscapeEmpty) onEscapeEmpty();
      else e.currentTarget.blur();
    }
  };
  const hint = !isMail ? replyPlace(facts, inThread) : shown?.mode === "forward" ? "Add a note" : compose ? "Reply" : replyPlace(facts);
  const sendKey = isMail ? "cmd+enter" : undefined;
  const signature = shown?.signature !== false ? (compose?.from.find((f) => f.address === (shown?.from ?? compose.default_from))?.signature ?? "") : "";
  const hasSignature = !!compose?.from.find((f) => f.address === (shown?.from ?? compose.default_from))?.signature;
  const size = touch ? "var(--phone-text-body)" : "var(--text-sm)";
  const framed = isMail && !touch;
  const discard = () => {
    setText("");
    if (compose) setMail(startAddressing(compose));
    setLineOpen(false);
  };
  const notSent = facts.not_sent && <NotSentLine note={facts.not_sent} touch={touch} onUnsent={onUnsent} />;
  if (items)
    return (
      <>
        {notSent}
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
            placeholder: isMail ? hint : facts.provider === "jira" ? "write a comment…" : "write a reply…",
            "aria-label": hint,
            ...mentions.field,
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
            title: nobody ? "Add someone to send it to first" : SEND_TITLE[facts.provider],
            keys: sendKey ? formatKeys(sendKey) : keyFor("chat.send"),
            onSend: () => void send(),
          }}
          discard={isMail ? { disabled: off || (!text && mail === null), onDiscard: discard } : null}
          error={error}
          actions={isMail ? null : actions}
        />
      </>
    );
  return (
    <div
      className={framed ? "loki-mail-compose" : undefined}
      style={framed ? undefined : { display: "flex", flexDirection: "column", gap: touch ? "var(--phone-space-2)" : 8 }}
    >
      {notSent}
      {isMail && !folded && (
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
      <div className="flex flex-col" style={{ position: "relative" }}>
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
          rows={folded ? 1 : touch ? 4 : 3}
          disabled={off}
          placeholder={hint}
          aria-label={hint}
          {...mentions.field}
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
      {isMail && compose && !folded && (hasSignature || quote) && (
        <div className={cn(framed && "loki-mail-compose-extra", "flex flex-col gap-1")}>
          {hasSignature && (
            <div className="flex min-w-0 items-baseline gap-2">
              {signature ? (
                <span className="min-w-0 flex-1" style={{ fontSize: size, color: "var(--loki-muted)", whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
                  {`-- \n${signature}`}
                </span>
              ) : (
                <Meta className="flex-1">No signature</Meta>
              )}
              <button
                type="button"
                className="loki-mail-line-who flex-none"
                disabled={off}
                onClick={() => shown && setMail({ ...shown, signature: !signature })}
              >
                {signature ? "Remove" : "Add Signature"}
              </button>
            </div>
          )}
          {quote && (
            <>
              <button
                type="button"
                className="loki-mail-quote-toggle"
                aria-expanded={quoteOpen}
                aria-label="Show the quoted mail"
                title={
                  touch
                    ? undefined
                    : shown?.mode === "forward"
                      ? "The mail goes under your note, with its files"
                      : "The mail you answer goes quoted under your reply"
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
      {(!folded || busy) && (
        <div className={cn(framed && "loki-mail-compose-foot", "flex items-center gap-2")}>
          <Button
            size={touch ? "touch" : "sm"}
            tone="positive"
            disabled={off || !text.trim()}
            onClick={() => void send()}
            kbd={touch ? undefined : sendKey ? formatKeys(sendKey) : keyFor("chat.send")}
            title={touch ? "Send it as you; the card stays" : nobody ? "Add someone to send it to first" : SEND_TITLE[facts.provider]}
          >
            {busy ? "Sending…" : "Send"}
          </Button>
          {touch && busy && onUndo && (
            <Button size="touch" onClick={onUndo}>
              Undo
            </Button>
          )}
          {touch && !error && !busy && <Meta wrap>{SEND_NOTE[facts.provider]}</Meta>}
          {framed && error && (
            <Meta negative wrap className="flex-1">
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
              title="Clear the reply and its recipients"
            >
              Discard
            </Button>
          ) : (
            actions
          )}
        </div>
      )}
      {!framed && error && (
        <Meta negative wrap>
          {error}
        </Meta>
      )}
    </div>
  );
}

function NotSentLine({
  note,
  touch,
  onUnsent,
}: {
  note: NotSentReply;
  touch: boolean;
  onUnsent?: (outboxId: string, action: "resend" | "discard") => Promise<string | null>;
}) {
  const [busy, setBusy] = useState<"resend" | "discard" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const act = async (action: "resend" | "discard") => {
    if (!onUnsent || busy) return;
    setBusy(action);
    setError(null);
    try {
      setError(await onUnsent(note.outbox_id, action));
    } catch (e) {
      setBusy(null);
      throw e;
    }
    setBusy(null);
  };
  const size = touch ? "touch" : "sm";
  return (
    <div role="alert" className="flex flex-col" style={{ gap: touch ? "var(--phone-space-1)" : 4 }}>
      <Meta negative wrap>
        Not sent: {error ?? note.reason}
      </Meta>
      <div className="flex min-w-0 items-center gap-2">
        <Meta className="min-w-0 flex-1" title={note.text}>
          “{firstLine(note.text)}”
        </Meta>
        {onUnsent && (
          <>
            <Button size={size} tone="positive" disabled={!!busy} onClick={() => void act("resend")} title="Looks in the thread first, so it never goes twice">
              {busy === "resend" ? "Sending…" : "Send Again"}
            </Button>
            <Button size={size} bare disabled={!!busy} onClick={() => void act("discard")} title="Let it go; the card stops saying it was not sent">
              Discard
            </Button>
          </>
        )}
      </div>
    </div>
  );
}

export function DeckReply({
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
  row?: ReactNode;
  compose: MailCompose | null;
}) {
  const people = source?.searchPeople;
  const pick = source?.pickPerson;
  const settle = source?.settleUnsent;
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
      onPickPerson={pick ? (p) => pick(current, p) : undefined}
      inThread={thread.kind === "read" && !!thread.opened}
      items={items}
      onUnsent={settle ? (outboxId, action) => settle(current, outboxId, action) : undefined}
    />
  );
}
