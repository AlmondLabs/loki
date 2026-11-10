import { useState, type KeyboardEvent } from "react";
import type { ReplyOutcome } from "../../../core/attention/chat-store.ts";
import type { Runtime } from "../../../core/attention/protocol.ts";
import type { ChatFace } from "../../../core/attention/use-attention.ts";
import type { ReplyProposal } from "../../../core/frame-types.ts";
import type { ReplyAction } from "../../../core/frames.ts";
import { messageOf } from "../../../core/errors.ts";
import { Button, Meta, TextArea, sentence } from "../components";

/**
 * Reply proposals in a chat (plan 067, U10, KTD9): a reply the agent wrote for a thread the person handed it, as a card
 * above the message box, in the chat and on its Inbox card, on the desktop and the phone, whatever the chat's
 * permission mode. It names the account, the thread and who it goes to, as the thread decides; the text can be edited;
 * approve has loki write it as a draft there for the person to send, reject writes nothing.
 */

/** What the cards read and call, all of it useAttention's; a host whose source lacks them shows no cards. */
export interface ReplySource {
  conversation: (agentId: string, conversationId: string) => Pick<ChatFace, "replyProposals">;
  replies: {
    decide: (rt: Runtime, proposalId: string, action: ReplyAction, opts?: { text?: string | null; replace?: boolean }) => Promise<ReplyOutcome>;
  };
}

/** A chat's reply cards as a host hands them over: where they are read, which chat, and why nothing can be done now. */
export interface ReplyProposalsProps {
  source: Partial<ReplySource>;
  rt: Runtime;
  /** Why nothing can be done now (the phone while its Mac is out of reach): the buttons are disabled and this says why. */
  blocked?: string | null;
  touch?: boolean;
}

const SERVICE = { gmail: "Gmail", slack: "Slack", jira: "Jira" } as const;

/** The words of a control: lowercase on the desktop, sentence case on the phone. */
const say = (touch: boolean, words: string) => (touch ? sentence(words) : words);

/** Who a reply goes to, as its card says it: Gmail's people, or Slack's place. */
function recipientsText(p: Pick<ReplyProposal, "provider" | "to" | "cc" | "place">): string {
  if (p.provider === "slack") return `in ${p.place ?? "that conversation"}`;
  return [p.to.length ? `to ${p.to.join(", ")}` : "", p.cc.length ? `cc ${p.cc.join(", ")}` : ""].filter(Boolean).join(" · ") || "to no one";
}

/** The replies proposed in a chat that wait on the person or are being drafted; nothing when there are none. */
export function ReplyProposalCards({ source, rt, blocked = null, touch = false }: ReplyProposalsProps) {
  const decide = source.replies?.decide;
  const proposals = source.conversation?.(rt.agent_id, rt.conversation_id).replyProposals ?? [];
  if (!decide || proposals.length === 0) return null;
  return (
    <ul aria-label={say(touch, "replies waiting for you")} style={{ listStyle: "none", margin: 0, padding: 0 }}>
      {proposals.map((p) => (
        <li key={p.id}>
          <ReplyProposalCard proposal={p} touch={touch} blocked={blocked} onDecide={(action, opts) => decide(rt, p.id, action, opts)} />
        </li>
      ))}
    </ul>
  );
}

/** The phone's Inbox card takes a drag for a swipe; a drag or a tap inside the reply's text is the text's. */
const stopEvent = (e: { stopPropagation: () => void }) => e.stopPropagation();

/** One reply: where it goes, its text to edit, and approve or reject; a Slack draft already there is replaced only when asked. */
function ReplyProposalCard({
  proposal: p,
  touch,
  blocked,
  onDecide,
}: {
  proposal: ReplyProposal;
  touch: boolean;
  blocked: string | null;
  onDecide: (action: ReplyAction, opts: { text?: string | null; replace?: boolean }) => Promise<ReplyOutcome>;
}) {
  const [text, setText] = useState(p.text);
  const [busy, setBusy] = useState(false);
  const [refused, setRefused] = useState<{ message: string | null; replace: boolean } | null>(null);
  const drafting = p.status === "drafting";
  const off = busy || drafting || !!blocked;
  const size = touch ? "touch" : "sm";
  const act = async (action: ReplyAction) => {
    setBusy(true);
    try {
      const out = await onDecide(action, action === "approve" ? { text: text === p.text ? null : text, replace: refused?.replace === true } : {});
      setRefused(out.done ? null : { message: out.message, replace: out.replace });
    } catch (err: unknown) {
      // A call that throws leaves the card usable and says why, rather than holding its buttons off for good.
      setRefused({ message: messageOf(err), replace: false });
    } finally {
      setBusy(false);
    }
  };
  // The Inbox's single keys are the deck's; inside the text they are the text's.
  const keys = (e: KeyboardEvent) => e.stopPropagation();
  const reason = refused?.message ?? p.reason;
  return (
    <div className="loki-suggestion" data-reply={p.id} onPointerDown={stopEvent} onPointerMove={stopEvent} onPointerUp={stopEvent}>
      <div className="loki-suggestion-head" style={{ cursor: "default" }}>
        <span className="loki-suggestion-kicker">{say(touch, "reply")}</span>
        <span className="loki-suggestion-title">
          {p.subject || "a thread"} · {p.account_label}
        </span>
        <span className="loki-suggestion-target">{recipientsText(p)}</span>
      </div>
      <div className="loki-suggestion-body">
        <TextArea
          size={size}
          value={text}
          rows={touch ? 5 : 4}
          disabled={off}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={keys}
          aria-label={say(touch, "reply text")}
        />
        {drafting && (
          <div className="loki-suggestion-note" role="status">
            {say(touch, `writing the draft in ${SERVICE[p.provider]}…`)}
          </div>
        )}
        {!drafting && reason && (
          <div className="loki-suggestion-note" data-refused role="alert">
            {reason}
          </div>
        )}
        {blocked && <div className="loki-suggestion-note">{blocked}</div>}
        {!drafting && (
          <div className="loki-suggestion-actions">
            <Button size={size} tone="positive" disabled={off || !text.trim()} onClick={() => void act("approve")} data-action="approve">
              {say(touch, refused?.replace ? "replace the draft" : "approve")}
            </Button>
            <Button size={size} tone="negative" disabled={off} onClick={() => void act("reject")} data-action="reject">
              {say(touch, "reject")}
            </Button>
            <Meta wrap>{say(touch, `saved as a draft in ${SERVICE[p.provider]}; you send it from there`)}</Meta>
          </div>
        )}
      </div>
    </div>
  );
}
