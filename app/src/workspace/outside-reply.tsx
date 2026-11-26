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

function buildMentionSource({
  isMail,
  shown,
  compose,
  provider,
  setMail,
  searchPeople,
  onPickPerson,
}: {
  isMail: boolean;
  shown: MailAddressing | null;
  compose: MailCompose | null;
  provider: OutsideFacts["provider"];
  setMail: (mail: MailAddressing) => void;
  searchPeople?: (query: string) => Promise<SlackPerson[]>;
  onPickPerson?: (person: SlackPerson) => void;
}): MentionSource | null {
  if (isMail && shown && compose) {
    return {
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
    };
  }
  if (provider === "slack" && searchPeople) {
    return {
      later: (q) =>
        searchPeople(q).then((people) => ({
          list: people.map((p) => ({ key: p.id, label: p.name, sub: `@${p.handle}`, insert: p.name, onPick: () => onPickPerson?.(p) })),
        })),
    };
  }
  return null;
}

function resolveReplyMeta({
  facts,
  compose,
  shown,
  inThread,
  touch,
}: {
  facts: OutsideFacts;
  compose: MailCompose | null;
  shown: MailAddressing | null;
  inThread: boolean;
  touch: boolean;
}) {
  const isMail = facts.provider === "gmail";
  const hint = !isMail ? replyPlace(facts, inThread) : shown?.mode === "forward" ? "Add a note" : compose ? "Reply" : replyPlace(facts);
  const sendKey = isMail ? "cmd+enter" : undefined;
  const senderEntry = compose?.from.find((f) => f.address === (shown?.from ?? compose.default_from));
  const rawSignature = senderEntry?.signature ?? "";
  const signature = shown?.signature !== false ? rawSignature : "";
  const hasSignature = !!rawSignature;
  return {
    isMail,
    hint,
    sendKey,
    signature,
    hasSignature,
    nobody: !!shown && shown.to.length + shown.cc.length + shown.bcc.length === 0,
    size: touch ? "var(--phone-text-body)" : "var(--text-sm)",
    framed: isMail && !touch,
  };
}

function resolveBoxBinding(
  box: ReplyBoxControl | undefined,
  own: {
    text: string;
    setText: (next: string) => void;
    mail: MailAddressing | null;
    setMail: (next: MailAddressing | null) => void;
    busy: boolean;
    error: string | null;
  },
) {
  return {
    text: box ? box.text : own.text,
    setText: box ? box.onText : own.setText,
    mail: box ? box.mail : own.mail,
    setMail: box ? box.onMail : own.setMail,
    busy: box ? box.busy : own.busy,
    error: box ? box.error : own.error,
  };
}

function useOutsideReplyController({
  facts,
  box,
  keep,
  compose,
  inThread,
  touch,
  searchPeople,
  onPickPerson,
  onSend,
  onEscapeEmpty,
}: {
  facts: OutsideFacts;
  box?: ReplyBoxControl;
  keep?: string;
  compose: MailCompose | null;
  inThread: boolean;
  touch: boolean;
  searchPeople?: (query: string) => Promise<SlackPerson[]>;
  onPickPerson?: (person: SlackPerson) => void;
  onSend?: (text: string, mail: MailAddressing | null) => Promise<{ sent: boolean; error: string | null; undone?: true }>;
  onEscapeEmpty?: () => void;
}) {
  const [ownText, setOwnText] = useSeededReply(facts.seeds, keep ?? null, !!box);
  const [ownMail, setOwnMail] = useState<MailAddressing | null>(null);
  const [ownBusy, setBusy] = useState(false);
  const [ownError, setError] = useState<string | null>(null);
  const [lineOpen, setLineOpen] = useState(false);
  const [quoteOpen, setQuoteOpen] = useState(false);
  const ownRef = useRef<HTMLTextAreaElement | null>(null);

  const { text, setText, mail, setMail, busy, error } = resolveBoxBinding(box, {
    text: ownText,
    setText: setOwnText,
    mail: ownMail,
    setMail: setOwnMail,
    busy: ownBusy,
    error: ownError,
  });
  const off = busy || !!facts.disconnected;
  const shown = compose ? (mail ?? startAddressing(compose)) : null;
  const meta = resolveReplyMeta({ facts, compose, shown, inThread, touch });
  const source = buildMentionSource({ isMail: meta.isMail, shown, compose, provider: facts.provider, setMail, searchPeople, onPickPerson });
  const mentions = useMentions({ text, setText, source: off ? null : source, ref: ownRef });

  const send = async () => {
    if (off || !text.trim()) return;
    if (meta.nobody) {
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
    const key = replyBoxKey(e.nativeEvent, keyboard, meta.isMail);
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

  const discard = () => {
    setText("");
    if (compose) setMail(startAddressing(compose));
    setLineOpen(false);
  };

  return {
    ownRef,
    text,
    setText,
    mail,
    setMail,
    busy,
    error,
    off,
    shown,
    meta,
    lineOpen,
    setLineOpen,
    quoteOpen,
    setQuoteOpen,
    mentions,
    send,
    keys,
    discard,
  };
}

type ReplyController = ReturnType<typeof useOutsideReplyController>;

function replyFieldBindings(
  ctrl: ReplyController,
  inputRef: RefObject<HTMLTextAreaElement | null> | undefined,
  onTyping: ((typing: boolean) => void) | undefined,
) {
  const { ownRef, text, off, meta, mentions, setText, keys } = ctrl;
  return {
    ref: (el: HTMLTextAreaElement | null) => {
      ownRef.current = el;
      if (inputRef) inputRef.current = el;
    },
    value: text,
    disabled: off,
    "aria-label": meta.hint,
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
  };
}

function itemReplyBoxProps({
  ctrl,
  facts,
  compose,
  quote,
  inputRef,
  onTyping,
  actions,
}: {
  ctrl: ReplyController;
  facts: OutsideFacts;
  compose: MailCompose | null;
  quote: string | null;
  inputRef?: RefObject<HTMLTextAreaElement | null>;
  onTyping?: (typing: boolean) => void;
  actions: ReactNode;
}) {
  const { meta, shown, mentions, off, text, mail, busy, error, setMail, lineOpen, setLineOpen, send, discard } = ctrl;
  const fieldBase = replyFieldBindings(ctrl, inputRef, onTyping);
  const placeholder = meta.isMail ? meta.hint : facts.provider === "jira" ? "write a comment…" : "write a reply…";
  return {
    isMail: meta.isMail,
    target: meta.isMail ? (
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
      meta.hint
    ),
    mentions: mentions.list,
    field: { ...fieldBase, placeholder },
    signature:
      meta.isMail && compose && meta.hasSignature ? { text: meta.signature, toggle: () => shown && setMail({ ...shown, signature: !meta.signature }) } : null,
    quote: meta.isMail && compose && quote ? { text: quote, forward: shown?.mode === "forward" } : null,
    send: {
      busy,
      disabled: off || !text.trim(),
      title: meta.nobody ? "Add someone to send it to first" : SEND_TITLE[facts.provider],
      keys: meta.sendKey ? formatKeys(meta.sendKey) : keyFor("chat.send"),
      onSend: () => void send(),
    },
    discard: meta.isMail ? { disabled: off || (!text && mail === null), onDiscard: discard } : null,
    error,
    actions: meta.isMail ? null : actions,
  };
}

function OutsideItemReply({
  ctrl,
  facts,
  compose,
  quote,
  inputRef,
  onTyping,
  actions,
  notSent,
}: {
  ctrl: ReplyController;
  facts: OutsideFacts;
  compose: MailCompose | null;
  quote: string | null;
  inputRef?: RefObject<HTMLTextAreaElement | null>;
  onTyping?: (typing: boolean) => void;
  actions: ReactNode;
  notSent: ReactNode;
}) {
  const boxProps = itemReplyBoxProps({ ctrl, facts, compose, quote, inputRef, onTyping, actions });
  return (
    <>
      {notSent}
      <ItemReplyBox {...boxProps} />
    </>
  );
}

function MailReplyExtras({ ctrl, quote, touch }: { ctrl: ReplyController; quote: string | null; touch: boolean }) {
  const { meta, off, shown, setMail, quoteOpen, setQuoteOpen } = ctrl;
  if (!meta.hasSignature && !quote) return null;
  const quoteTitle = touch
    ? undefined
    : shown?.mode === "forward"
      ? "The mail goes under your note, with its files"
      : "The mail you answer goes quoted under your reply";
  return (
    <div className={cn(meta.framed && "loki-mail-compose-extra", "flex flex-col gap-1")}>
      {meta.hasSignature && (
        <div className="flex min-w-0 items-baseline gap-2">
          {meta.signature ? (
            <span className="min-w-0 flex-1" style={{ fontSize: meta.size, color: "var(--loki-muted)", whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
              {`-- \n${meta.signature}`}
            </span>
          ) : (
            <Meta className="flex-1">No signature</Meta>
          )}
          <button
            type="button"
            className="loki-mail-line-who flex-none"
            disabled={off}
            onClick={() => shown && setMail({ ...shown, signature: !meta.signature })}
          >
            {meta.signature ? "Remove" : "Add Signature"}
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
            title={quoteTitle}
            onClick={() => setQuoteOpen(!quoteOpen)}
          >
            •••
          </button>
          {quoteOpen && (
            <div className="loki-mail-quote" style={{ fontSize: meta.size }}>
              {quote}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function footerModel(ctrl: ReplyController, facts: OutsideFacts, touch: boolean, onUndo: (() => void) | undefined) {
  const { meta, off, text, mail, busy, error } = ctrl;
  return {
    framed: meta.framed,
    size: touch ? ("touch" as const) : ("sm" as const),
    sendDisabled: off || !text.trim(),
    sendKbd: touch ? undefined : meta.sendKey ? formatKeys(meta.sendKey) : keyFor("chat.send"),
    sendTitle: touch ? "Send it as you; the card stays" : meta.nobody ? "Add someone to send it to first" : SEND_TITLE[facts.provider],
    sendText: busy ? "Sending…" : "Send",
    showUndo: touch && busy && !!onUndo,
    showNote: touch && !error && !busy,
    framedError: meta.framed ? error : null,
    discardDisabled: off || (!text && mail === null),
  };
}

function OutsideReplyFooter({
  ctrl,
  facts,
  touch,
  onUndo,
  actions,
}: {
  ctrl: ReplyController;
  facts: OutsideFacts;
  touch: boolean;
  onUndo?: () => void;
  actions: ReactNode;
}) {
  const model = footerModel(ctrl, facts, touch, onUndo);
  return (
    <div className={cn(model.framed && "loki-mail-compose-foot", "flex items-center gap-2")}>
      <Button size={model.size} tone="positive" disabled={model.sendDisabled} onClick={() => void ctrl.send()} kbd={model.sendKbd} title={model.sendTitle}>
        {model.sendText}
      </Button>
      {model.showUndo && onUndo && (
        <Button size="touch" onClick={onUndo}>
          Undo
        </Button>
      )}
      {model.showNote && <Meta wrap>{SEND_NOTE[facts.provider]}</Meta>}
      {model.framedError && (
        <Meta negative wrap className="flex-1">
          {model.framedError}
        </Meta>
      )}
      {model.framed ? (
        <Button
          size="sm"
          bare
          disabled={model.discardDisabled}
          onClick={ctrl.discard}
          style={{ marginLeft: "auto" }}
          title="Clear the reply and its recipients"
        >
          Discard
        </Button>
      ) : (
        actions
      )}
    </div>
  );
}

function composerLayout(ctrl: ReplyController, compose: MailCompose | null, touch: boolean, folded: boolean) {
  const { meta, busy, error } = ctrl;
  return {
    rootClass: meta.framed ? "loki-mail-compose" : undefined,
    rootStyle: meta.framed ? undefined : { display: "flex", flexDirection: "column" as const, gap: touch ? "var(--phone-space-2)" : 8 },
    headClass: meta.framed ? "loki-mail-compose-head" : undefined,
    showHead: meta.isMail && !folded,
    textSize: touch ? ("touch" as const) : ("sm" as const),
    textBare: meta.framed,
    textClass: meta.framed ? "loki-mail-compose-text" : undefined,
    rows: folded ? 1 : touch ? 4 : 3,
    showExtras: meta.isMail && !!compose && !folded,
    showFooter: !folded || busy,
    trailingError: !meta.framed ? error : null,
  };
}

function OutsideReplyComposer({
  ctrl,
  facts,
  compose,
  quote,
  inputRef,
  onTyping,
  actions,
  onUndo,
  touch,
  folded,
  notSent,
}: {
  ctrl: ReplyController;
  facts: OutsideFacts;
  compose: MailCompose | null;
  quote: string | null;
  inputRef?: RefObject<HTMLTextAreaElement | null>;
  onTyping?: (typing: boolean) => void;
  actions: ReactNode;
  onUndo?: () => void;
  touch: boolean;
  folded: boolean;
  notSent: ReactNode;
}) {
  const { off, mail, setMail, lineOpen, setLineOpen, mentions, meta } = ctrl;
  const layout = composerLayout(ctrl, compose, touch, folded);
  const field = replyFieldBindings(ctrl, inputRef, onTyping);
  return (
    <div className={layout.rootClass} style={layout.rootStyle}>
      {notSent}
      {layout.showHead && (
        <div className={layout.headClass}>
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
        <TextArea size={layout.textSize} bare={layout.textBare} className={layout.textClass} rows={layout.rows} placeholder={meta.hint} {...field} />
      </div>
      {layout.showExtras && <MailReplyExtras ctrl={ctrl} quote={quote} touch={touch} />}
      {layout.showFooter && <OutsideReplyFooter ctrl={ctrl} facts={facts} touch={touch} onUndo={onUndo} actions={actions} />}
      {layout.trailingError && (
        <Meta negative wrap>
          {layout.trailingError}
        </Meta>
      )}
    </div>
  );
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
  const ctrl = useOutsideReplyController({ facts, box, keep, compose, inThread, touch, searchPeople, onPickPerson, onSend, onEscapeEmpty });
  const notSent = facts.not_sent ? <NotSentLine note={facts.not_sent} touch={touch} onUnsent={onUnsent} /> : null;
  if (items) {
    return (
      <OutsideItemReply ctrl={ctrl} facts={facts} compose={compose} quote={quote} inputRef={inputRef} onTyping={onTyping} actions={actions} notSent={notSent} />
    );
  }
  return (
    <OutsideReplyComposer
      ctrl={ctrl}
      facts={facts}
      compose={compose}
      quote={quote}
      inputRef={inputRef}
      onTyping={onTyping}
      actions={actions}
      onUndo={onUndo}
      touch={touch}
      folded={folded}
      notSent={notSent}
    />
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
    } finally {
      setBusy(null);
    }
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
