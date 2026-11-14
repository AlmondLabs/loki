import { useState, type KeyboardEvent, type ReactNode } from "react";
import type { PendingApproval } from "../../../core/attention/model.ts";
import { offersAlways } from "../../../core/attention/model.ts";
import { formatInput } from "../../../core/attention/format.ts";
import type { ReplyAttachment, ReplyProposal } from "../../../core/frame-types.ts";
import { Button } from "@/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/ui/dialog";
import { Textarea } from "@/ui/textarea";
import { Suggestion as SuggestionChip, Suggestions as SuggestionChips } from "@/ui/ai-elements/suggestion";
import { cn } from "@/lib/utils";
import { STILL_GOES, fileText, peopleChanged, recipientsText, sendNote, sentText, type ReplyProposalsProps } from "../desk/reply-proposal-card";
import { revealFile, revealLabel, useReplyCard, useSentReplies, type DecideReply } from "../desk/use-reply-card";
import { inTauri } from "../desk/env";
import { sentence } from "../components";
import { replyKeyDown } from "../chat/quick-replies";

/*
 * Proposal (plan 097, R9): anything the agent asks the person to decide, drawn in one frame whatever its kind. The
 * frame names the kind and where it applies, then shows what is proposed, then buttons that say what yes does. The
 * kinds: an approval (a tool call paused for the person), a question, a reply for an outside thread, and quick replies.
 * loki's Suggestion (a message for another chat) keeps its chip in the message box for now; AI Elements' Suggestion is
 * imported as SuggestionChip, so the two words never meet in this file (KTD4).
 */

/** What kind of decision a Proposal holds, which names it and sets its tone. */
export type ProposalKind = "approval" | "question" | "reply";

/**
 * The frame every Proposal shares: its kind and where it applies, what is proposed, and the answers. An approval or a
 * question is a plain card with the attention dot by its name: the red is a dot, never a panel (docs/design.md), and the
 * words stay in the text colour so they read on night's dark card, where the red alone falls under AA.
 */
export function ProposalFrame({ kind, where, children, className }: { kind: ProposalKind; where?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section
      data-proposal={kind}
      aria-label={kind === "approval" ? "Needs your approval" : kind === "question" ? "A question for you" : "A reply waiting for you"}
      className={cn("flex flex-col gap-2 rounded-lg border bg-card p-3 text-body", kind === "reply" && "border-dashed border-ring", className)}
    >
      <header className="flex min-w-0 items-center gap-2 text-meta">
        {kind !== "reply" && <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-loki-attention" />}
        <span className={cn("font-semibold", kind === "reply" ? "text-ring" : "text-foreground")}>{kind}</span>
        {where && <span className="min-w-0 truncate text-muted-foreground">{where}</span>}
      </header>
      {children}
    </section>
  );
}

/** The first line of a call's input, for the one-line summary under the approval's question. */
const inputLine = (input: unknown): string =>
  formatInput(input)
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l && l !== "{" && l !== "[") ?? "";

/**
 * The tool call the agent is paused on (KTD6; plan 2026-11-12-1505, U4): a question naming the agent and the step, the
 * input's first line under it, then Deny, Always Allow and Allow, Allow the default as a Mac alert's is. The whole input
 * opens from the summary. Keys show in the buttons' tooltips, not on their faces (KTD7).
 */
export function ApprovalProposal({
  approval,
  onApprove,
  hints,
  who,
}: {
  approval: PendingApproval;
  onApprove: (behavior: "allow" | "deny" | "always") => void;
  /** Flow's A and D, shown in the buttons' tooltips when the host gives them. */
  hints?: { approve?: string; deny?: string };
  /** The agent asking, for the question the approval puts. */
  who?: string;
}) {
  const [open, setOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const line = inputLine(approval.input);
  const tip = (word: string, key: string | undefined) => (key ? `${word} (${key})` : word);
  return (
    <section data-proposal="approval" aria-label={`${who ?? "the agent"} needs your approval`} className="flex flex-col gap-2 px-4 py-3 text-body">
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
              className="min-w-0 cursor-pointer truncate text-left text-meta text-muted-foreground hover:text-foreground"
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
      {open && <pre className="m-0 max-h-48 overflow-auto rounded-md bg-muted px-3 py-2 text-meta">{formatInput(approval.input)}</pre>}
      {/* A grant for good, in every chat, asks first (R11), as a Mac asks before a change it cannot quietly take back. */}
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

/** A question the agent asked, or a chat link it asks for: today's card for its answers, inside the Proposal frame. */
export function QuestionProposal({ children, where }: { children: ReactNode; where?: string }) {
  return (
    <ProposalFrame kind="question" where={where}>
      {children}
    </ProposalFrame>
  );
}

/**
 * The replies the agent proposed from this chat for outside threads (plan 067; plan 2026-11-14-1134, U7), each a
 * Proposal: where it goes, its text and files, then Send (from the person's account, after a 10-second hold with Undo)
 * and Reject. A reply just sent stays for a moment saying where it went. The text is edited in place until the Composer
 * can take a reply's target (plan 097, R10, U7).
 */
export function ReplyProposals({ source, rt, blocked = null, reveal = inTauri ? revealFile : null }: Omit<ReplyProposalsProps, "touch">) {
  const decide = source.replies?.decide;
  const proposals = source.conversation?.(rt.agent_id, rt.conversation_id).replyProposals ?? NONE;
  const sent = useSentReplies(proposals);
  if (!decide || proposals.length + sent.length === 0) return null;
  return (
    <div className="flex flex-col gap-2">
      {proposals.map((p) => (
        <ReplyProposalView key={p.id} proposal={p} blocked={blocked} reveal={reveal} onDecide={(action, opts) => decide(rt, p.id, action, opts)} />
      ))}
      {sent.map((p) => (
        <ProposalFrame
          key={p.id}
          kind="reply"
          where={
            <>
              {p.subject || "a thread"} · {p.account_label}
            </>
          }
        >
          <p role="status" data-sent className="m-0 text-meta text-muted-foreground">
            {sentText(p)}
          </p>
        </ProposalFrame>
      ))}
    </div>
  );
}

/** No proposals, as one array, so the list a host without any gives reads the same each render. */
const NONE: ReplyProposal[] = [];

/**
 * A reply's files on the desktop card: each with its size, Show in Finder where it can be shown, and Remove or Put
 * Back; a file already on a Jira ticket says so and cannot be taken off. Its own component, so the card stays readable.
 */
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
    <ul aria-label="Files" data-attachments className="m-0 flex list-none flex-col gap-1 p-0 text-meta text-muted-foreground">
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

/**
 * One reply proposal: a quiet quote of its text until Edit opens it, its files, then Send and Reject; while sending,
 * Undo. A refusal says why, and a change in the thread's people is spelled out.
 */
export function ReplyProposalView({
  proposal: p,
  blocked,
  reveal = null,
  onDecide,
}: {
  proposal: ReplyProposal;
  blocked: string | null;
  /** Shows a file in its folder; null where that cannot be done. */
  reveal?: ((path: string) => void) | null;
  onDecide: DecideReply;
}) {
  const { undoRef, ...card } = useReplyCard(p, onDecide);
  const [editing, setEditing] = useState(false);
  const off = card.busy || card.sending || !!blocked;
  // Flow's single keys are the deck's; inside the text they are the text's.
  const keys = (e: KeyboardEvent) => e.stopPropagation();
  return (
    <ProposalFrame
      kind="reply"
      where={
        <>
          {p.subject || "a thread"} · {p.account_label} · {recipientsText(p)}
        </>
      }
    >
      <div data-reply={p.id} className="flex flex-col gap-2">
        {peopleChanged(p) && (
          <p className="m-0 text-meta" data-people="changed">
            {sentence(recipientsText(p))}
          </p>
        )}
        {editing ? (
          <Textarea value={card.text} rows={4} disabled={off} onChange={(e) => card.setText(e.target.value)} onKeyDown={keys} aria-label="Reply text" />
        ) : (
          <blockquote className="m-0 border-l-2 border-border pl-3 whitespace-pre-wrap">{card.text}</blockquote>
        )}
        <ReplyFiles files={p.attachments ?? []} kept={card.kept} attached={p.attached ?? []} disabled={off} reveal={reveal} onToggle={card.toggleFile} />
        {card.sending && (
          <p role="status" className="m-0 text-meta text-muted-foreground">
            Sending…
          </p>
        )}
        {card.reason && (
          <p role="alert" className="m-0 text-meta text-destructive">
            {card.reason}
          </p>
        )}
        {blocked && !card.sending && <p className="m-0 text-meta text-muted-foreground">{blocked}</p>}
        {blocked && card.sending && <p className="m-0 text-meta text-muted-foreground">{STILL_GOES}</p>}
        <div className="flex flex-wrap items-center gap-2">
          {card.sending ? (
            <Button ref={undoRef} size="sm" variant="outline" disabled={card.busy || !!blocked} onClick={card.undo} data-action="undo">
              Undo
            </Button>
          ) : (
            <>
              <Button size="sm" disabled={off || !card.text.trim()} onClick={card.send} data-action="approve">
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
              <span className="text-meta text-muted-foreground">{sendNote(p)}</span>
            </>
          )}
        </div>
      </div>
    </ProposalFrame>
  );
}

/**
 * The agent's quick replies (plan 066) as AI Elements' Suggestion chips at the end of the thread: a press sends the
 * option as the person's message. With a chip focused, 1 to 4 send theirs; each key is in its chip's tooltip, not on
 * its face (docs/style.md §6).
 */
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
