import type { KeyboardEvent } from "react";
import type { ReplyOutcome } from "../../../core/attention/chat-store.ts";
import type { Runtime } from "../../../core/attention/protocol.ts";
import type { ChatFace } from "../../../core/attention/use-attention.ts";
import type { ReplyAttachment, ReplyProposal } from "../../../core/frame-types.ts";
import type { ReplyAction, ReplyDecideOptions } from "../../../core/frames.ts";
import { fileSize } from "../chat/attachments";
import { Button, Meta, TextArea, sentence } from "../components";
import { inTauri } from "./env";
import { revealFile, revealLabel, useReplyCard, useSentReplies, type DecideReply } from "./use-reply-card";

/**
 * Reply proposals in a chat (plan 067, U10; plan 2026-11-14-1134, U7): a reply the agent wrote for a thread the person
 * handed it, as a card above the message box, on the desktop and the phone, whatever the chat's permission mode. It
 * names the account, the thread and who it goes to, as the thread decides; the text can be edited and files taken off;
 * Send sends it from the person's account after a 10-second hold with Undo, and Reject sends nothing.
 */

/** What the cards read and call, all of it useAttention's; a host whose source lacks them shows no cards. */
export interface ReplySource {
  conversation: (agentId: string, conversationId: string) => Pick<ChatFace, "replyProposals">;
  replies: {
    decide: (rt: Runtime, proposalId: string, action: ReplyAction, opts?: ReplyDecideOptions) => Promise<ReplyOutcome>;
  };
}

/** A chat's reply cards as a host hands them over: where they are read, which chat, and why nothing can be done now. */
export interface ReplyProposalsProps {
  source: Partial<ReplySource>;
  rt: Runtime;
  /** Why nothing can be done now (the phone while its Mac is out of reach): the buttons are disabled and this says why. */
  blocked?: string | null;
  touch?: boolean;
  /** Shows a file in its folder; null where that cannot be done (a browser, the phone). The desktop app's opener by default. */
  reveal?: ((path: string) => void) | null;
}

/** What each service's card calls a reply, in the kicker over it. */
export const REPLY_WORDS: Record<ReplyProposal["provider"], { kicker: string }> = {
  gmail: { kicker: "reply" },
  slack: { kicker: "reply" },
  jira: { kicker: "comment" },
};

/** The line under Send: where pressing it sends the reply, and the hold (R3, R4). */
export function sendNote(p: Pick<ReplyProposal, "provider" | "attachments">): string {
  switch (p.provider) {
    case "gmail":
      return "Sends from your account with your signature, held 10 seconds so you can undo";
    case "slack":
      return "Sends from your account, held 10 seconds so you can undo";
    case "jira":
      return p.attachments?.length
        ? "Posts on the ticket from your account with its files attached, held 10 seconds so you can undo"
        : "Posts on the ticket from your account, held 10 seconds so you can undo";
  }
}

/** While the Mac that holds a sending reply is out of reach: Undo cannot reach it, and the reply goes anyway. */
export const STILL_GOES = "Undo needs your Mac: the reply still goes when its 10 seconds are up.";

/** A person's bare address, from "Name <address>" or the address alone, for matching the marks of who changed. */
const addressOf = (person: string): string => (/<([^>]+)>/.exec(person)?.[1] ?? person).trim().toLowerCase();

/**
 * Who a reply goes to, as its card says it: Gmail's people, Slack's place, or the Jira ticket. After a Send refused
 * because the thread's people changed (R7), each person who joined is marked "added" and each who left is named
 * "removed", in words rather than colour alone.
 */
export function recipientsText(p: Pick<ReplyProposal, "provider" | "to" | "cc" | "place" | "people_added" | "people_removed">): string {
  switch (p.provider) {
    case "slack":
      return `in ${p.place ?? "that conversation"}`;
    case "jira":
      return `on ${p.place ?? "the ticket"}`;
    case "gmail": {
      const added = new Set((p.people_added ?? []).map(addressOf));
      const named = (people: string[]) => people.map((x) => (added.has(addressOf(x)) ? `${x} (added)` : x)).join(", ");
      const gone = (p.people_removed ?? []).map((x) => `${x} (removed)`).join(", ");
      return [p.to.length ? `to ${named(p.to)}` : "", p.cc.length ? `cc ${named(p.cc)}` : "", gone].filter(Boolean).join(" · ") || "to no one";
    }
  }
}

/** True when a Gmail reply came back because the thread's people changed, so its card spells out who. */
export const peopleChanged = (p: Pick<ReplyProposal, "people_added" | "people_removed">): boolean =>
  (p.people_added?.length ?? 0) + (p.people_removed?.length ?? 0) > 0;

/** A sent reply's last words on its card: "Sent", and where it went. */
export const sentText = (p: ReplyProposal): string => `Sent ${recipientsText(p)}`;

/** A file as a card names it: its name and size. */
export const fileText = (f: Pick<ReplyAttachment, "name" | "size">): string => `${f.name} (${fileSize(f.size)})`;

/** The replies proposed in a chat that wait on the person or are sending, and for a moment each one just sent. */
export function ReplyProposalCards({ source, rt, blocked = null, touch = false, reveal = inTauri ? revealFile : null }: ReplyProposalsProps) {
  const decide = source.replies?.decide;
  const proposals = source.conversation?.(rt.agent_id, rt.conversation_id).replyProposals ?? NONE;
  const sent = useSentReplies(proposals);
  if (!decide || proposals.length + sent.length === 0) return null;
  return (
    <ul aria-label="Replies waiting for you" style={{ listStyle: "none", margin: 0, padding: 0 }}>
      {proposals.map((p) => (
        <li key={p.id}>
          <ReplyProposalCard
            proposal={p}
            touch={touch}
            blocked={blocked}
            reveal={touch ? null : reveal}
            onDecide={(action, opts) => decide(rt, p.id, action, opts)}
          />
        </li>
      ))}
      {sent.map((p) => (
        <li key={p.id}>
          <div className="loki-suggestion" data-reply={p.id} data-sent>
            <div className="loki-suggestion-note" role="status">
              {sentText(p)}
            </div>
          </div>
        </li>
      ))}
    </ul>
  );
}

/** No proposals, as one array, so the list a host without any gives reads the same each render. */
const NONE: ReplyProposal[] = [];

/** The phone's Inbox card takes a drag for a swipe; a drag or a tap inside the reply's text is the text's. */
const stopEvent = (e: { stopPropagation: () => void }) => e.stopPropagation();

/**
 * A reply's files on the touch card: each with its size, Show in Finder where it can be shown, and Remove or Put Back;
 * a file already on a Jira ticket says so and cannot be taken off. Its own component, so the card stays readable.
 */
function ReplyFiles({
  files,
  kept,
  attached,
  disabled,
  reveal,
  onToggle,
  size,
}: {
  files: readonly ReplyAttachment[];
  kept: readonly ReplyAttachment[];
  attached: readonly string[];
  disabled: boolean;
  reveal: ((path: string) => void) | null;
  onToggle: (name: string) => void;
  size: "touch" | "sm";
}) {
  if (files.length === 0) return null;
  return (
    <ul aria-label="Files" data-attachments style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 4 }}>
      {files.map((f) => {
        const on = kept.includes(f);
        return (
          <li key={f.name} className="loki-suggestion-note" data-file={f.name} style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
            <span style={{ textDecoration: on ? undefined : "line-through" }}>{fileText(f)}</span>
            {attached.includes(f.name) ? (
              <span>Already on the ticket</span>
            ) : (
              <>
                {!on && <span>Taken off</span>}
                {reveal && (
                  <Button size={size} bare onClick={() => reveal(f.path)} data-action="reveal" aria-label={`${revealLabel()}: ${f.name}`}>
                    {revealLabel()}
                  </Button>
                )}
                <Button
                  size={size}
                  bare
                  disabled={disabled}
                  onClick={() => onToggle(f.name)}
                  data-action={on ? "remove-file" : "keep-file"}
                  aria-label={on ? `Remove ${f.name}` : `Put Back ${f.name}`}
                >
                  {on ? "Remove" : "Put Back"}
                </Button>
              </>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/** One reply: where it goes, its text and files to edit, then Send and Reject, or Undo while it is sending. */
function ReplyProposalCard({
  proposal: p,
  touch,
  blocked,
  reveal,
  onDecide,
}: {
  proposal: ReplyProposal;
  touch: boolean;
  blocked: string | null;
  reveal: ((path: string) => void) | null;
  onDecide: DecideReply;
}) {
  const { undoRef, ...card } = useReplyCard(p, onDecide);
  const off = card.busy || card.sending || !!blocked;
  const size = touch ? "touch" : "sm";
  // The Inbox's single keys are the deck's; inside the text they are the text's.
  const keys = (e: KeyboardEvent) => e.stopPropagation();
  return (
    <div className="loki-suggestion" data-reply={p.id} onPointerDown={stopEvent} onPointerMove={stopEvent} onPointerUp={stopEvent}>
      <div className="loki-suggestion-head" style={{ cursor: "default" }}>
        <span className="loki-suggestion-kicker">{sentence(REPLY_WORDS[p.provider].kicker)}</span>
        <span className="loki-suggestion-title">
          {p.subject || "a thread"} · {p.account_label}
        </span>
        <span className="loki-suggestion-target" data-people={peopleChanged(p) ? "changed" : undefined}>
          {recipientsText(p)}
        </span>
      </div>
      <div className="loki-suggestion-body">
        <TextArea
          size={size}
          value={card.text}
          rows={touch ? 5 : 4}
          disabled={off}
          onChange={(e) => card.setText(e.target.value)}
          onKeyDown={keys}
          aria-label="Reply text"
        />
        <ReplyFiles
          files={p.attachments ?? []}
          kept={card.kept}
          attached={p.attached ?? []}
          disabled={off}
          reveal={reveal}
          onToggle={card.toggleFile}
          size={size}
        />
        {card.sending && (
          <div className="loki-suggestion-note" role="status">
            Sending…
          </div>
        )}
        {card.reason && (
          <div className="loki-suggestion-note" data-refused role="alert">
            {card.reason}
          </div>
        )}
        {blocked && !card.sending && <div className="loki-suggestion-note">{blocked}</div>}
        {blocked && card.sending && <div className="loki-suggestion-note">{STILL_GOES}</div>}
        <div className="loki-suggestion-actions">
          {card.sending ? (
            <Button ref={undoRef} size={size} disabled={card.busy || !!blocked} onClick={card.undo} data-action="undo">
              Undo
            </Button>
          ) : (
            <>
              <Button size={size} tone="positive" disabled={off || !card.text.trim()} onClick={card.send} data-action="approve">
                Send
              </Button>
              <Button size={size} tone="negative" disabled={off} onClick={card.reject} data-action="reject">
                Reject
              </Button>
              <Meta wrap>{sendNote(p)}</Meta>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
