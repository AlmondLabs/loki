import { useRef, type KeyboardEvent, type RefObject } from "react";
import type { ReplyOutcome } from "../../../core/attention/chat-store.ts";
import type { Runtime } from "../../../core/attention/protocol.ts";
import type { ChatFace } from "../../../core/attention/use-attention.ts";
import type { ReplyAttachment, ReplyMention, ReplyPersonChoice, ReplyProposal } from "../../../core/frame-types.ts";
import type { ReplyAction, ReplyDecideOptions } from "../../../core/frames.ts";
import { fileSize } from "../chat/attachments";
import { Button, Field, Meta, TextArea, sentence } from "../components";
import { inDesktop } from "./env";
import { MentionMarks } from "./mention-field";
import { useMentions, type MentionSource } from "./mentions";
import { revealFile, revealLabel, useReplyCard, useSentReplies, type DecideReply, type ReplyCard } from "./use-reply-card";

export interface ReplySource {
  conversation: (agentId: string, conversationId: string) => Pick<ChatFace, "replyProposals">;
  replies: {
    decide: (rt: Runtime, proposalId: string, action: ReplyAction, opts?: ReplyDecideOptions) => Promise<ReplyOutcome>;
    findPeople?: (rt: Runtime, proposalId: string, query: string) => Promise<{ people: ReplyPersonChoice[]; notice: string | null } | string>;
  };
}

export type FindReplyPeople = (query: string) => Promise<{ people: ReplyPersonChoice[]; notice: string | null } | string>;

export function replyPeopleSource(find: FindReplyPeople, pick: (m: ReplyMention) => void): MentionSource {
  return {
    later: async (query) => {
      const r = await find(query);
      if (typeof r === "string") throw new Error(r);
      return {
        notice: r.notice,
        list: r.people.map((c) => {
          const { detail, ...mention } = c;
          return {
            key: c.id ?? c.address ?? c.display,
            label: c.display,
            sub: c.not_member ? "Not in this conversation" : detail,
            insert: c.display,
            onPick: () => pick(mention),
          };
        }),
      };
    },
  };
}

export function useReplyMentions(
  card: Pick<ReplyCard, "text" | "setText" | "mentions" | "pick">,
  find: FindReplyPeople | null,
  off: boolean,
  ref: RefObject<HTMLTextAreaElement | null>,
) {
  const source = find && !off ? replyPeopleSource(find, card.pick) : null;
  const picker = useMentions({ text: card.text, setText: card.setText, source, ref });
  return {
    list: picker.list,
    marks: <MentionMarks text={card.text} mentions={card.mentions} field={ref} />,
    onKeyDown: picker.onKeyDown,
    onCaret: picker.onCaret,
    field: picker.field,
  };
}

export function mentionNotes(p: Pick<ReplyProposal, "provider" | "to" | "cc" | "place">, mentions: readonly ReplyMention[]): string[] {
  if (p.provider === "gmail") {
    const on = new Set([...p.to, ...p.cc].map(addressOf));
    return mentions.flatMap((m) => (m.address && !on.has(m.address.toLowerCase()) ? [`Adds ${m.display} (${m.address}) to cc.`] : []));
  }
  if (p.provider === "slack") {
    const where = (p.place ?? "this conversation").replace(/^the thread in /, "");
    return mentions.filter((m) => m.not_member).map((m) => `${m.display} is not in ${where} and will not be notified.`);
  }
  return [];
}

export interface ReplyProposalsProps {
  source: Partial<ReplySource>;
  rt: Runtime;
  blocked?: string | null;
  touch?: boolean;
  reveal?: ((path: string) => void) | null;
}

export const REPLY_WORDS: Record<ReplyProposal["provider"], { kicker: string }> = {
  gmail: { kicker: "reply" },
  slack: { kicker: "reply" },
  jira: { kicker: "comment" },
};

export const kickerOf = (p: Pick<ReplyProposal, "provider" | "kind">): string =>
  p.kind === "email" ? "new email" : p.kind === "dm" ? "new DM" : p.kind === "ticket" ? "new ticket" : REPLY_WORDS[p.provider].kicker;

export function sendNote(p: Pick<ReplyProposal, "provider" | "attachments" | "kind">): string {
  if (p.kind === "email") return "Sends a new email from your account with your signature, held 10 seconds so you can undo";
  if (p.kind === "dm") return "Opens the DM and sends from your account, held 10 seconds so you can undo";
  if (p.kind === "ticket") return "Creates the ticket in Jira from your account, held 10 seconds so you can undo";
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

export const STILL_GOES = "Undo needs your Mac: the reply still goes when its 10 seconds are up.";

const addressOf = (person: string): string => (/<([^>]+)>/.exec(person)?.[1] ?? person).trim().toLowerCase();

export function recipientsText(p: Pick<ReplyProposal, "provider" | "to" | "cc" | "place" | "people_added" | "people_removed">): string {
  switch (p.provider) {
    case "slack":
      return `in ${p.place ?? "that conversation"}`;
    case "jira":
      return p.place?.startsWith("a new ") ? `as ${p.place}` : `on ${p.place ?? "the ticket"}`;
    case "gmail": {
      const added = new Set((p.people_added ?? []).map(addressOf));
      const named = (people: string[]) => people.map((x) => (added.has(addressOf(x)) ? `${x} (added)` : x)).join(", ");
      const gone = (p.people_removed ?? []).map((x) => `${x} (removed)`).join(", ");
      return [p.to.length ? `to ${named(p.to)}` : "", p.cc.length ? `cc ${named(p.cc)}` : "", gone].filter(Boolean).join(" · ") || "to no one";
    }
  }
}

const SUBJECT_MAX = 100;

export function quotedSubject(p: Pick<ReplyProposal, "subject" | "kind">): string {
  const line = p.subject.replace(/\s+/g, " ").trim();
  if (!line) return p.kind === "dm" ? "a new DM" : "a thread";
  return `“${line.length > SUBJECT_MAX ? `${line.slice(0, SUBJECT_MAX - 1)}…` : line}”`;
}

function heardByWords(h: NonNullable<ReplyProposal["heard_by"]>): string {
  const people =
    h.assignee && h.assignee === h.reporter
      ? [`${h.assignee} (assignee and reporter)`]
      : [h.assignee ? `${h.assignee} (assignee)` : "", h.reporter ? `${h.reporter} (reporter)` : ""].filter(Boolean);
  if (h.watchers > 0) people.push(h.watchers === 1 ? "1 watcher" : `${String(h.watchers)} watchers`);
  if (people.length === 0) return "Jira usually tells no one of this comment.";
  const last = people.pop() ?? "";
  return `Jira usually tells ${people.length ? `${people.join(", ")} and ${last}` : last}.`;
}

export function destinationNotes(p: Pick<ReplyProposal, "provider" | "in_flow" | "shared_outside" | "heard_by" | "ticket">): string[] {
  const notes: string[] = [];
  if (p.ticket) {
    const t = p.ticket;
    if (t.parent) notes.push(`Under ${t.parent}.`);
    notes.push(t.assignee ? `Assigned to ${t.assignee.display}.` : "Assigned to no one.");
    if (t.priority) notes.push(`Priority ${t.priority.name}.`);
    if (t.labels.length) notes.push(`Labels ${t.labels.join(", ")}.`);
  }
  if (p.in_flow === false) notes.push(p.provider === "jira" ? "This ticket has no card in Flow." : "This thread has no card in Flow.");
  if (p.shared_outside) notes.push("This conversation is shared with people outside your workspace.");
  if (p.heard_by) {
    notes.push(heardByWords(p.heard_by));
    if (p.heard_by.customer_sees) notes.push("The customer sees this comment.");
  }
  return notes;
}

export const peopleChanged = (p: Pick<ReplyProposal, "people_added" | "people_removed">): boolean =>
  (p.people_added?.length ?? 0) + (p.people_removed?.length ?? 0) > 0;

export const sentText = (p: ReplyProposal): string => `Sent ${recipientsText(p)}`;

export const fileText = (f: Pick<ReplyAttachment, "name" | "size">): string => `${f.name} (${fileSize(f.size)})`;

export function ReplyProposalCards({ source, rt, blocked = null, touch = false, reveal = inDesktop ? revealFile : null }: ReplyProposalsProps) {
  const decide = source.replies?.decide;
  const findPeople = source.replies?.findPeople;
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
            find={findPeople ? (q) => findPeople(rt, p.id, q) : null}
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

const NONE: ReplyProposal[] = [];

const stopEvent = (e: { stopPropagation: () => void }) => e.stopPropagation();

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
    <ul aria-label="Files" data-attachments className="grid gap-1" style={{ listStyle: "none", margin: 0, padding: 0 }}>
      {files.map((f) => {
        const on = kept.includes(f);
        return (
          <li key={f.name} className="loki-suggestion-note flex flex-wrap items-center gap-2" data-file={f.name}>
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

function ReplyNotes({ sending, reason, blocked }: { sending: boolean; reason: string | null; blocked: string | null }) {
  return (
    <>
      {sending && (
        <div className="loki-suggestion-note" role="status">
          Sending…
        </div>
      )}
      {reason && (
        <div className="loki-suggestion-note" data-refused role="alert">
          {reason}
        </div>
      )}
      {blocked && <div className="loki-suggestion-note">{sending ? STILL_GOES : blocked}</div>}
    </>
  );
}

function ReplyProposalCard({
  proposal: p,
  touch,
  blocked,
  reveal,
  onDecide,
  find,
}: {
  proposal: ReplyProposal;
  touch: boolean;
  blocked: string | null;
  reveal: ((path: string) => void) | null;
  onDecide: DecideReply;
  find: FindReplyPeople | null;
}) {
  const { undoRef, ...card } = useReplyCard(p, onDecide);
  const off = card.busy || card.sending || !!blocked;
  const field = useRef<HTMLTextAreaElement | null>(null);
  const mentions = useReplyMentions(card, find, off, field);
  const size = touch ? "touch" : "sm";
  const keys = (e: KeyboardEvent) => e.stopPropagation();
  return (
    <div className="loki-suggestion" data-reply={p.id} onPointerDown={stopEvent} onPointerMove={stopEvent} onPointerUp={stopEvent}>
      <div className="loki-suggestion-head" style={{ cursor: "default" }}>
        <span className="loki-suggestion-kicker">{sentence(kickerOf(p))}</span>
        <span className="loki-suggestion-title">
          {quotedSubject(p)} · {p.account_label}
        </span>
        <span className="loki-suggestion-target" data-people={peopleChanged(p) ? "changed" : undefined}>
          {recipientsText(p)}
        </span>
      </div>
      <div className="loki-suggestion-body">
        {[...destinationNotes(p), ...mentionNotes(p, card.mentions)].map((note) => (
          <div key={note} className="loki-suggestion-note" data-destination-note>
            {note}
          </div>
        ))}
        {p.kind === "ticket" && (
          <Field size={size} value={card.title} disabled={off} onChange={(e) => card.setTitle(e.target.value)} onKeyDown={keys} aria-label="Ticket title" />
        )}
        <div className="loki-mention-field">
          {mentions.list}
          <TextArea
            ref={field}
            size={size}
            value={card.text}
            rows={touch ? 5 : 4}
            disabled={off}
            onChange={(e) => {
              card.setText(e.target.value);
              mentions.onCaret(e.target);
            }}
            onSelect={(e) => mentions.onCaret(e.currentTarget)}
            onBlur={() => mentions.onCaret(null)}
            onKeyDown={(e) => {
              if (!mentions.onKeyDown(e)) keys(e);
            }}
            aria-label="Reply text"
            {...mentions.field}
          />
          {mentions.marks}
        </div>
        <ReplyFiles
          files={p.attachments ?? []}
          kept={card.kept}
          attached={p.attached ?? []}
          disabled={off}
          reveal={reveal}
          onToggle={card.toggleFile}
          size={size}
        />
        <ReplyNotes sending={card.sending} reason={card.reason} blocked={blocked} />
        <div className="loki-suggestion-actions">
          {card.sending ? (
            <Button ref={undoRef} size={size} disabled={card.busy || !!blocked} onClick={card.undo} data-action="undo">
              Undo
            </Button>
          ) : (
            <>
              <Button
                size={size}
                tone="positive"
                disabled={off || !(p.kind === "ticket" ? card.title : card.text).trim()}
                onClick={card.send}
                data-action="approve"
              >
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
