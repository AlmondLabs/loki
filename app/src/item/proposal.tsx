import { useState, type KeyboardEvent, type ReactNode } from "react";
import type { PendingApproval } from "../../../core/attention/model.ts";
import { offersAlways } from "../../../core/attention/model.ts";
import { formatInput } from "../../../core/attention/format.ts";
import type { ReplyProposal } from "../../../core/frame-types.ts";
import type { ReplyAction } from "../../../core/frames.ts";
import type { ReplyOutcome } from "../../../core/attention/chat-store.ts";
import { messageOf } from "../../../core/errors.ts";
import { Button } from "@/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/ui/dialog";
import { Kbd } from "@/ui/kbd";
import { Textarea } from "@/ui/textarea";
import { Confirmation, ConfirmationActions, ConfirmationRequest } from "@/ui/ai-elements/confirmation";
import { Suggestion as SuggestionChip, Suggestions as SuggestionChips } from "@/ui/ai-elements/suggestion";
import { Tool, ToolContent, ToolHeader, ToolInput } from "@/ui/ai-elements/tool";
import { cn } from "@/lib/utils";
import { useLook } from "../theme";
import { recipientsText, REPLY_WORDS, type ReplyProposalsProps } from "../desk/reply-proposal-card";

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
      aria-label={kind === "approval" ? "needs your approval" : kind === "question" ? "a question for you" : "a reply waiting for you"}
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

/** A button's key shown beside its words, as Flow's keys are. */
const keyOf = (key: string | undefined) => (key ? <Kbd className="ml-1">{key}</Kbd> : null);

/**
 * The tool call the agent is paused on (KTD6): AI Elements' Tool in its "awaiting approval" state with Confirmation
 * inside, its input, then approve, always allow (where the tool may be allowed for good) and deny. Flow's A and D are
 * shown on the buttons when the host gives them.
 */
export function ApprovalProposal({
  approval,
  onApprove,
  hints,
  who,
}: {
  approval: PendingApproval;
  onApprove: (behavior: "allow" | "deny" | "always") => void;
  hints?: { approve?: string; deny?: string };
  /** The agent asking, for the question Liquid Glass puts it as. */
  who?: string;
}) {
  const look = useLook();
  if (look === "glass") return <GlassApproval approval={approval} onApprove={onApprove} hints={hints} who={who} />;
  return (
    <ProposalFrame kind="approval" where="the agent is paused on this step">
      <Tool open className="mb-0 bg-background">
        <ToolHeader chevron={false} title={approval.toolName} type={`tool-${approval.toolName}`} state="approval-requested" />
        <ToolContent>
          <ToolInput input={formatInput(approval.input)} />
        </ToolContent>
      </Tool>
      <Confirmation approval={{ id: approval.requestId }} state="approval-requested" className="border-0 bg-transparent p-0">
        <ConfirmationRequest>
          <ConfirmationActions className="self-start">
            <Button size="sm" onClick={() => onApprove("allow")} data-action="approve">
              approve{keyOf(hints?.approve)}
            </Button>
            {offersAlways(approval) && (
              <Button
                size="sm"
                variant="outline"
                onClick={() => onApprove("always")}
                title="allow this tool from now on, in every chat (Preferences › Chat takes it back)"
                data-action="always"
              >
                always allow
              </Button>
            )}
            <Button size="sm" variant="ghost" onClick={() => onApprove("deny")} data-action="deny">
              deny{keyOf(hints?.deny)}
            </Button>
          </ConfirmationActions>
        </ConfirmationRequest>
      </Confirmation>
    </ProposalFrame>
  );
}

/** The first line of a call's input, for the one-line summary under the approval's question. */
const inputLine = (input: unknown): string =>
  formatInput(input)
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l && l !== "{" && l !== "[") ?? "";

/**
 * The approval under Liquid Glass (plan 2026-11-12-1505, U4): a question naming the agent and the step, the input's
 * first line under it, then Deny, Always Allow and Allow, Allow the default as a Mac alert's is. The whole input
 * opens from the summary. Keys show in the buttons' tooltips, not on their faces (KTD7).
 */
function GlassApproval({
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
 * The replies the agent proposed from this chat for outside threads (plan 067), each a Proposal: where it goes, its
 * text, approve (loki writes it as a draft there, or for Jira puts it in the ticket's comment box) and reject. The text
 * is edited in place until the Composer can take a reply's target (plan 097, R10, U7).
 */
export function ReplyProposals({ source, rt, blocked = null }: Omit<ReplyProposalsProps, "touch">) {
  const decide = source.replies?.decide;
  const proposals = source.conversation?.(rt.agent_id, rt.conversation_id).replyProposals ?? [];
  if (!decide || proposals.length === 0) return null;
  return (
    <div className="flex flex-col gap-2">
      {proposals.map((p) => (
        <ReplyProposalView key={p.id} proposal={p} blocked={blocked} onDecide={(action, opts) => decide(rt, p.id, action, opts)} />
      ))}
    </div>
  );
}

/**
 * What approving a reply proposal sends as the person's edit: their text when they changed it, else none, so the
 * proposal goes as the agent wrote it last, even when it was still being drafted when the card opened.
 */
export function replyEdit(edited: string | null, proposed: string): string | null {
  return edited === null || edited === proposed ? null : edited;
}

/** One reply proposal: a quiet quote of its text until edit opens it, then approve or reject; a refusal says why. */
export function ReplyProposalView({
  proposal: p,
  blocked,
  onDecide,
}: {
  proposal: ReplyProposal;
  blocked: string | null;
  onDecide: (action: ReplyAction, opts: { text?: string | null; replace?: boolean }) => Promise<ReplyOutcome>;
}) {
  // The person's own edit, null until they change the text: until then the text is the proposal's as it is now, so a
  // proposal still being drafted keeps following the agent, and approving it sends no edit.
  const [edited, setEdited] = useState<string | null>(null);
  const text = edited ?? p.text;
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [refused, setRefused] = useState<{ message: string | null; replace: boolean } | null>(null);
  const drafting = p.status === "drafting";
  const off = busy || drafting || !!blocked;
  const words = REPLY_WORDS[p.provider];
  const act = async (action: "approve" | "reject") => {
    setBusy(true);
    try {
      const out = await onDecide(action, action === "approve" ? { text: replyEdit(edited, p.text), replace: refused?.replace === true } : {});
      setRefused(out.done ? null : { message: out.message, replace: out.replace });
    } catch (err: unknown) {
      setRefused({ message: messageOf(err), replace: false });
    } finally {
      setBusy(false);
    }
  };
  // Flow's single keys are the deck's; inside the text they are the text's.
  const keys = (e: KeyboardEvent) => e.stopPropagation();
  const reason = refused?.message ?? p.reason;
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
        {editing ? (
          <Textarea value={text} rows={4} disabled={off} onChange={(e) => setEdited(e.target.value)} onKeyDown={keys} aria-label="reply text" />
        ) : (
          <blockquote className="m-0 border-l-2 border-border pl-3 whitespace-pre-wrap">{text}</blockquote>
        )}
        {drafting && (
          <p role="status" className="m-0 text-meta text-muted-foreground">
            {words.writing}
          </p>
        )}
        {!drafting && reason && (
          <p role="alert" className="m-0 text-meta text-destructive">
            {reason}
          </p>
        )}
        {blocked && <p className="m-0 text-meta text-muted-foreground">{blocked}</p>}
        {!drafting && (
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" disabled={off || !text.trim()} onClick={() => void act("approve")} data-action="approve">
              {refused?.replace ? "replace the draft" : "approve"}
            </Button>
            {!editing && (
              <Button size="sm" variant="outline" disabled={off} onClick={() => setEditing(true)} data-action="edit">
                edit
              </Button>
            )}
            <Button size="sm" variant="ghost" disabled={off} onClick={() => void act("reject")} data-action="reject">
              reject
            </Button>
            <span className="text-meta text-muted-foreground">{words.after}</span>
          </div>
        )}
      </div>
    </ProposalFrame>
  );
}

/**
 * The agent's quick replies (plan 066) as AI Elements' Suggestion chips at the end of the thread: a press sends the
 * option as the person's message; on the Mac each shows its key, 1 to 4, which sends it from an empty box.
 */
export function QuickReplyChips({ options, onPick }: { options: readonly string[]; onPick: (text: string) => void }) {
  return (
    <SuggestionChips role="group" aria-label="quick replies" className="py-1">
      {options.map((option, i) => (
        <SuggestionChip key={option} suggestion={option} onClick={onPick} title={`send "${option}"`} className="gap-1.5 px-3">
          {option}
          <Kbd>{String(i + 1)}</Kbd>
        </SuggestionChip>
      ))}
    </SuggestionChips>
  );
}
