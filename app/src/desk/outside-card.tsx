import type { AccountDisconnectCause, AccountProvider, OutsideFacts, OutsideMessage } from "../../../core/frame-types.ts";
import { useEffect, useEffectEvent, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from "react";
import type { AttentionItem } from "../../../core/attention/model.ts";
import type { OutsideSource } from "../../../core/attention/use-attention.ts";
import { Button, Chip, Meta, TextArea, Title } from "../components";
import { chordIds, keyFor } from "../shell/keymap";
import { ago, deckKey } from "./catch-up-parts";

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

/** One message: who wrote it (or "you"), when, and its text. */
function MessageRow({ m, touch }: { m: OutsideMessage; touch: boolean }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8, minWidth: 0 }}>
        <span style={{ fontSize: touch ? "var(--phone-text-body)" : 13.5, fontWeight: 600, color: m.mine ? "var(--loki-positive)" : undefined }}>
          {m.mine ? "you" : senderName(m.sender)}
        </span>
        {m.at && <Meta>{ago(m.at)}</Meta>}
      </div>
      <p style={{ margin: 0, whiteSpace: "pre-wrap", overflowWrap: "anywhere", fontSize: touch ? "var(--phone-text-body)" : 13.5 }}>{m.text}</p>
    </div>
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
    if (count) end.current?.scrollIntoView({ block: "end" });
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
  return (
    <div style={{ display: "flex", flexDirection: "column", gap }}>
      {state.messages.map((m) => (
        <MessageRow key={m.id} m={m} touch={touch} />
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

/**
 * The reply box under the thread (plan 068): the person's own words, sent in the thread as they wrote them, which then
 * archives the card. Enter sends, as in a chat's box; Esc hands the deck's keys back, or closes the deck when the box is empty. A send that
 * fails keeps the text and says why.
 */
export function OutsideReply({
  facts,
  onSend,
  inputRef,
  onTyping,
  onEscapeEmpty,
  touch = false,
  actions = null,
}: {
  facts: OutsideFacts;
  onSend: (text: string) => Promise<string | null>;
  /** The card's other moves, drawn on the row after send, so the card has one bar of buttons. */
  actions?: ReactNode;
  inputRef?: RefObject<HTMLTextAreaElement | null>;
  onTyping?: (typing: boolean) => void;
  onEscapeEmpty?: () => void;
  touch?: boolean;
}) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const off = busy || !!facts.disconnected;
  const send = async () => {
    if (off || !text.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const err = await onSend(text);
      if (err) setError(err);
    } finally {
      setBusy(false);
    }
  };
  const keys = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // The deck's single keys are its own outside the box; inside, letters are the reply's.
    e.stopPropagation();
    // Enter sends and Shift-Enter starts a line, as in a chat's box (the keymap's chat.send and chat.newline).
    if (!e.nativeEvent.isComposing && chordIds(e.nativeEvent).includes("chat.send")) {
      e.preventDefault();
      void send();
    } else if (e.key === "Escape") {
      e.preventDefault();
      if (!text && onEscapeEmpty) onEscapeEmpty();
      else e.currentTarget.blur();
    }
  };
  const place = replyPlace(facts);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: touch ? "var(--phone-space-2)" : 8 }}>
      <TextArea
        ref={inputRef}
        size={touch ? "touch" : "sm"}
        value={text}
        rows={touch ? 4 : 3}
        disabled={off}
        placeholder={touch ? `${place[0].toUpperCase()}${place.slice(1)}` : place}
        aria-label={place}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={keys}
        onFocus={() => onTyping?.(true)}
        onBlur={() => onTyping?.(false)}
      />
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <Button
          size={touch ? "touch" : "sm"}
          tone="positive"
          disabled={off || !text.trim()}
          onClick={() => void send()}
          kbd={touch ? undefined : keyFor("chat.send")}
          title="send it as you, then archive the card"
        >
          {busy ? (touch ? "Sending…" : "sending…") : touch ? "Send" : "send"}
        </Button>
        {touch && !error && <Meta wrap>Sends as you, then archives the card.</Meta>}
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

/** The card's header: what it is about, who wrote, where and when, and the badge or the last move's flash. */
function OutsideHeader({ facts, badge, went, cameBack }: { facts: OutsideFacts; badge: string | null; went: string | null; cameBack: boolean }) {
  return (
    <div
      style={{
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
        gap: 12,
        padding: "14px 18px",
        borderBottom: "1px solid var(--loki-border)",
      }}
    >
      <div style={{ minWidth: 0 }}>
        <Title style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{outsideTitle(facts)}</Title>
        <div style={{ marginTop: 4, display: "flex", alignItems: "center", gap: 10, minWidth: 0, flexWrap: "wrap" }}>
          {facts.provider === "gmail" && <span style={{ fontSize: 12, fontWeight: 600 }}>{senderName(facts.sender)}</span>}
          <Meta>{outsideWho(facts)}</Meta>
          <Meta>{ago(facts.newest_at)}</Meta>
          {went && <Meta>{went}</Meta>}
          {cameBack && <Meta>back · new since you moved on</Meta>}
        </div>
      </div>
      {badge && <Chip tone="var(--loki-positive)">{badge}</Chip>}
    </div>
  );
}

/** Hand off, archive and next: they share the reply's row, so the card has one bar of buttons. */
function OutsideMoves({
  facts,
  typing,
  next,
  archive,
  onHandoff,
  picking,
}: {
  facts: OutsideFacts;
  typing: boolean;
  next: () => void;
  archive: () => void;
  onHandoff?: () => void;
  picking: boolean;
}) {
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
      <Button
        size="sm"
        onClick={archive}
        title={`done with this thread: it leaves the Inbox and is ${facts.provider === "gmail" ? "archived in Gmail" : "marked read in Slack"}`}
        kbd={deckKey("inbox.archive", typing)}
      >
        archive
      </Button>
      <span style={{ flex: 1 }} />
      <Button size="sm" tone="paper" onClick={next} title="set it aside: the thread stays for your next visit" kbd={deckKey("inbox.next", typing)}>
        next →
      </Button>
    </>
  );
}

/**
 * The desktop card for an outside thread: the header (who, where and when, and the badge's flash), the whole thread,
 * the reply box, and the deck's moves. Archive here archives the thread in its account; Next sets it aside; hand off
 * opens `picker`, where the thread goes to its account's agent (U8), and is off while the account is disconnected.
 */
export function OutsideCard({
  current,
  facts,
  flash,
  cameBack,
  typing,
  next,
  archive,
  went = null,
  onHandoff,
  picker = null,
  source = null,
  replyRef,
  onTyping,
  onEscapeEmpty,
}: {
  current: AttentionItem;
  facts: OutsideFacts;
  flash: string | null;
  cameBack: boolean;
  typing: boolean;
  next: () => void;
  archive: () => void;
  /** The chat the thread went to before, in words (`wentTo`). */
  went?: string | null;
  /** Open the hand-off picker; absent, the card has no hand off. */
  onHandoff?: () => void;
  /** The hand-off picker while it is open. */
  picker?: ReactNode;
  /** Reading the thread and sending the reply; absent, the card shows its last lines and no reply box. */
  source?: OutsideSource | null;
  replyRef?: RefObject<HTMLTextAreaElement | null>;
  onTyping?: (typing: boolean) => void;
  onEscapeEmpty?: () => void;
}) {
  const thread = useOutsideThread(current, source);
  const moves = <OutsideMoves facts={facts} typing={typing} next={next} archive={archive} onHandoff={onHandoff} picking={!!picker} />;
  return (
    <div style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>
      <OutsideHeader facts={facts} badge={flash ?? (current.unread ? "new" : null)} went={went} cameBack={cameBack} />
      <div style={{ flex: 1, minHeight: 0, overflow: "auto", padding: "16px 18px" }}>
        {facts.disconnected && (
          <Meta negative wrap style={{ display: "block", marginBottom: 12 }}>
            {disconnectedText(facts.disconnected, facts.provider)}
          </Meta>
        )}
        <OutsideThread facts={facts} state={thread} />
      </div>
      {picker && <div style={{ padding: "10px 18px", borderTop: "1px solid var(--loki-border)" }}>{picker}</div>}
      <div style={{ padding: "10px 18px", borderTop: "1px solid var(--loki-border)" }}>
        {source ? (
          <OutsideReply
            facts={facts}
            onSend={(text) => source.replyOutside(current, text)}
            inputRef={replyRef}
            onTyping={onTyping}
            onEscapeEmpty={onEscapeEmpty}
            actions={moves}
          />
        ) : (
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>{moves}</div>
        )}
      </div>
    </div>
  );
}
