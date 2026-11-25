import { useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import type { PendingApproval } from "../../../core/attention/model.ts";
import { offersAlways } from "../../../core/attention/model.ts";
import { formatInput } from "../../../core/attention/format.ts";
import type { ReplyAttachment, ReplyProposal } from "../../../core/frame-types.ts";
import { Button } from "@/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/ui/dialog";
import { Input } from "@/ui/input";
import { Textarea } from "@/ui/textarea";
import { Suggestion as SuggestionChip, Suggestions as SuggestionChips } from "@/ui/ai-elements/suggestion";
import { cn } from "@/lib/utils";
import {
  STILL_GOES,
  destinationNotes,
  fileText,
  mentionNotes,
  peopleChanged,
  quotedSubject,
  recipientsText,
  sendNote,
  sentText,
  useReplyMentions,
  type FindReplyPeople,
  type ReplyProposalsProps,
} from "../desk/reply-proposal-card";
import { MentionText } from "../desk/mention-field";
import { revealFile, revealLabel, useReplyCard, useSentReplies, type DecideReply } from "../desk/use-reply-card";
import { inDesktop } from "../desk/env";
import { sentence } from "../components";
import { replyKeyDown } from "../chat/quick-replies";

export type ProposalKind = "approval" | "question" | "reply";

export function ProposalFrame({ kind, where, children, className }: { kind: ProposalKind; where?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section
      data-proposal={kind}
      aria-label={kind === "approval" ? "Needs your approval" : kind === "question" ? "A question for you" : "A reply waiting for you"}
      className={cn("flex flex-col gap-2 rounded-lg border bg-card p-3 text-sm", kind === "reply" && "border-dashed border-ring", className)}
    >
      <header className="flex min-w-0 items-center gap-2 text-xs">
        {kind !== "reply" && <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-loki-attention" />}
        <span className={cn("font-semibold", kind === "reply" ? "text-ring" : "text-foreground")}>{kind}</span>
        {where && <span className="loki-truncate text-muted-foreground">{where}</span>}
      </header>
      {children}
    </section>
  );
}

const inputLine = (input: unknown): string =>
  formatInput(input)
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l && l !== "{" && l !== "[") ?? "";

export function ApprovalProposal({
  approval,
  onApprove,
  hints,
  who,
}: {
  approval: PendingApproval;
  onApprove: (behavior: "allow" | "deny" | "always") => void;
  hints?: { approve?: string; deny?: string };
  who?: string;
}) {
  const [open, setOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const line = inputLine(approval.input);
  const tip = (word: string, key: string | undefined) => (key ? `${word} (${key})` : word);
  return (
    <section data-proposal="approval" aria-label={`${who ?? "the agent"} needs your approval`} className="flex flex-col gap-2 px-4 py-3 text-sm">
      <div className="flex min-w-0 items-center gap-3">
        <span aria-hidden className="size-2 shrink-0 rounded-full bg-loki-attention" />
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="font-semibold text-foreground">
            Allow {who ?? "the agent"} to run “{approval.toolName}”?
          </span>
          {line && (
            <button
              type="button"
              aria-expanded={open}
              onClick={() => setOpen((o) => !o)}
              className="loki-truncate cursor-pointer text-left text-xs text-muted-foreground hover:text-foreground"
              title={open ? "Hide the input" : "Show the whole input"}
            >
              {line}
            </button>
          )}
        </div>
        <Button size="sm" variant="ghost" className="rounded-full" onClick={() => onApprove("deny")} data-action="deny" title={tip("Deny", hints?.deny)}>
          Deny
        </Button>
        {offersAlways(approval) && (
          <Button
            size="sm"
            variant="secondary"
            className="rounded-full"
            onClick={() => setConfirming(true)}
            title="Allow this tool from now on, in every chat (Preferences › Chat takes it back)"
            data-action="always"
          >
            Always Allow…
          </Button>
        )}
        <Button size="sm" className="rounded-full" onClick={() => onApprove("allow")} data-action="approve" title={tip("Allow", hints?.approve)}>
          Allow
        </Button>
      </div>
      {open && <pre className="m-0 max-h-48 overflow-auto rounded-md bg-muted px-3 py-2 text-xs">{formatInput(approval.input)}</pre>}
      <Dialog open={confirming} onOpenChange={setConfirming}>
        <DialogContent showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>Always allow “{approval.toolName}”?</DialogTitle>
            <DialogDescription>Every agent can then run it without asking, in every chat, from now on. Preferences › Chat takes it back.</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirming(false)} data-action="always-cancel">
              Cancel
            </Button>
            <Button
              onClick={() => {
                setConfirming(false);
                onApprove("always");
              }}
              data-action="always-confirm"
            >
              Always Allow
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}

export function QuestionProposal({ children, where }: { children: ReactNode; where?: string }) {
  return (
    <ProposalFrame kind="question" where={where}>
      {children}
    </ProposalFrame>
  );
}

export function ReplyProposals({ source, rt, blocked = null, reveal = inDesktop ? revealFile : null }: Omit<ReplyProposalsProps, "touch">) {
  const decide = source.replies?.decide;
  const findPeople = source.replies?.findPeople;
  const proposals = source.conversation?.(rt.agent_id, rt.conversation_id).replyProposals ?? NONE;
  const sent = useSentReplies(proposals);
  if (!decide || proposals.length + sent.length === 0) return null;
  return (
    <div className="flex flex-col gap-2">
      {proposals.map((p) => (
        <ReplyProposalView
          key={p.id}
          proposal={p}
          blocked={blocked}
          reveal={reveal}
          onDecide={(action, opts) => decide(rt, p.id, action, opts)}
          find={findPeople ? (q) => findPeople(rt, p.id, q) : null}
        />
      ))}
      {sent.map((p) => (
        <ProposalFrame
          key={p.id}
          kind="reply"
          where={
            <>
              {quotedSubject(p)} · {p.account_label}
            </>
          }
        >
          <p role="status" data-sent className="m-0 text-xs text-muted-foreground">
            {sentText(p)}
          </p>
        </ProposalFrame>
      ))}
    </div>
  );
}

const NONE: ReplyProposal[] = [];

function ReplyFiles({
  files,
  kept,
  attached,
  disabled,
  reveal,
  onToggle,
}: {
  files: readonly ReplyAttachment[];
  kept: readonly ReplyAttachment[];
  attached: readonly string[];
  disabled: boolean;
  reveal: ((path: string) => void) | null;
  onToggle: (name: string) => void;
}) {
  if (files.length === 0) return null;
  return (
    <ul aria-label="Files" data-attachments className="m-0 flex list-none flex-col gap-1 p-0 text-xs text-muted-foreground">
      {files.map((f) => {
        const on = kept.includes(f);
        return (
          <li key={f.name} data-file={f.name} className="flex flex-wrap items-center gap-2">
            <span className={cn(!on && "line-through")}>{fileText(f)}</span>
            {attached.includes(f.name) ? (
              <span>Already on the ticket</span>
            ) : (
              <>
                {!on && <span>Taken off</span>}
                {reveal && (
                  <Button size="sm" variant="ghost" onClick={() => reveal(f.path)} data-action="reveal" aria-label={`${revealLabel()}: ${f.name}`}>
                    {revealLabel()}
                  </Button>
                )}
                <Button
                  size="sm"
                  variant="ghost"
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
        <p role="status" className="m-0 text-xs text-muted-foreground">
          Sending…
        </p>
      )}
      {reason && (
        <p role="alert" className="m-0 text-xs text-destructive">
          {reason}
        </p>
      )}
      {blocked && <p className="m-0 text-xs text-muted-foreground">{sending ? STILL_GOES : blocked}</p>}
    </>
  );
}

export function ReplyProposalView({
  proposal: p,
  blocked,
  reveal = null,
  onDecide,
  find = null,
}: {
  proposal: ReplyProposal;
  blocked: string | null;
  reveal?: ((path: string) => void) | null;
  onDecide: DecideReply;
  find?: FindReplyPeople | null;
}) {
  const { undoRef, ...card } = useReplyCard(p, onDecide);
  const [editing, setEditing] = useState(false);
  const off = card.busy || card.sending || !!blocked;
  const field = useRef<HTMLTextAreaElement | null>(null);
  const mentions = useReplyMentions(card, find, off, field);
  const keys = (e: KeyboardEvent) => e.stopPropagation();
  return (
    <ProposalFrame
      kind="reply"
      where={
        <>
          {quotedSubject(p)} · {p.account_label} · {recipientsText(p)}
        </>
      }
    >
      <div data-reply={p.id} className="flex flex-col gap-2">
        {[...destinationNotes(p), ...mentionNotes(p, card.mentions)].map((note) => (
          <p key={note} className="m-0 text-xs text-muted-foreground" data-destination-note>
            {note}
          </p>
        ))}
        {peopleChanged(p) && (
          <p className="m-0 text-xs" data-people="changed">
            {sentence(recipientsText(p))}
          </p>
        )}
        {editing && p.kind === "ticket" && (
          <Input value={card.title} disabled={off} onChange={(e) => card.setTitle(e.target.value)} onKeyDown={keys} aria-label="Ticket title" />
        )}
        {editing ? (
          <div className="loki-mention-field">
            {mentions.list}
            <Textarea
              ref={field}
              value={card.text}
              rows={4}
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
        ) : (
          <blockquote className="m-0 border-l-2 border-border pl-3 whitespace-pre-wrap">
            <MentionText text={card.text} mentions={card.mentions} />
          </blockquote>
        )}
        <ReplyFiles files={p.attachments ?? []} kept={card.kept} attached={p.attached ?? []} disabled={off} reveal={reveal} onToggle={card.toggleFile} />
        <ReplyNotes sending={card.sending} reason={card.reason} blocked={blocked} />
        <div className="flex flex-wrap items-center gap-2">
          {card.sending ? (
            <Button ref={undoRef} size="sm" variant="outline" disabled={card.busy || !!blocked} onClick={card.undo} data-action="undo">
              Undo
            </Button>
          ) : (
            <>
              <Button size="sm" disabled={off || !(p.kind === "ticket" ? card.title : card.text).trim()} onClick={card.send} data-action="approve">
                Send
              </Button>
              {!editing && (
                <Button size="sm" variant="outline" disabled={off} onClick={() => setEditing(true)} data-action="edit">
                  Edit
                </Button>
              )}
              <Button size="sm" variant="ghost" disabled={off} onClick={card.reject} data-action="reject">
                Reject
              </Button>
              <span className="text-xs text-muted-foreground">{sendNote(p)}</span>
            </>
          )}
        </div>
      </div>
    </ProposalFrame>
  );
}

export function QuickReplyChips({ options, onPick }: { options: readonly string[]; onPick: (text: string) => void }) {
  return (
    <SuggestionChips role="group" aria-label="Quick replies" className="py-1" onKeyDown={replyKeyDown(options, onPick)}>
      {options.map((option, i) => (
        <SuggestionChip key={option} suggestion={option} onClick={onPick} title={`Send “${option}” (${i + 1})`} className="px-3">
          {option}
        </SuggestionChip>
      ))}
    </SuggestionChips>
  );
}
