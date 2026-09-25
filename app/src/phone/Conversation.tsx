import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { Runtime } from "../../../core/attention/protocol.ts";
import { keyOf, type AttentionItem, type PendingApproval, type PendingQuestion } from "../../../core/attention/model.ts";
import type { ImageAttachment } from "../../../core/attention/content.ts";
import type { ModelSelection, ReasoningEffort } from "../../../core/models.ts";
import type { ModelEntry } from "../chat/ModelPicker";
import type { TranscriptRow } from "../chat/Transcript";
import { Conversation, type ChatStatus } from "../chat/Conversation";
import { avatarUrl } from "../desk/env";
import { Button, Sheet } from "../components";
import { dayLabel, threadNotice, unreadBoundary } from "./deck";
import { SheetRow } from "./Home";
import { useViewed } from "../shared/useViewed";
import { doneAction } from "../shell/sidebarModel";
import { Icon } from "./icons";
import { threadLine } from "./model";
import { navigate } from "./router";
import { Avatar } from "./rows";
import { draftKey, useDraft } from "./session";

const noop = () => {};

/** The conversation a card opened; kept apart from the item so the screen survives the card clearing. */
export interface Thread {
  agentId: string;
  conversationId: string;
  title: string | null;
  agentName: string | null;
}

export interface ThreadView {
  rows: TranscriptRow[] | undefined;
  status: ChatStatus;
  pending: PendingApproval | null;
  question: PendingQuestion | null;
  error: string | null;
}

/**
 * One conversation, full screen, the way Slack lays out a DM on a phone. Explicit regions top to bottom:
 * the header (back, the agent and what it is doing, the actions circle), the thread (the only thing that
 * scrolls), the open question or approval, the notice pill, then the box, which owns the bottom inset
 * (the navigation is hidden on this page). The same Conversation the desk and the Inbox card show does the
 * work; the draft is the one the Inbox card for this conversation edits (session.ts). The box's model pill
 * opens Select model as a bottom sheet.
 */
export function ConversationScreen({
  thread,
  view,
  model = null,
  reasoningEffort = null,
  models = null,
  onLoadModels,
  onPickModel,
  item = null,
  waiting,
  banner,
  backLabel = "inbox",
  prefill = null,
  pinned = null,
  onPin,
  onBack,
  onLoad,
  onDecide,
  onAnswer,
  onSend,
  onSeen,
  onNotDone,
  onViewed,
}: {
  thread: Thread;
  view: ThreadView;
  /** The model the conversation runs on (the mod's desks list) and its effort; null when not known. */
  model?: string | null;
  reasoningEffort?: ReasoningEffort | null;
  /** list_models, for the pill's name and Select model; loaded on the first ask. */
  models?: ModelEntry[] | null;
  onLoadModels?: () => void;
  /** Switch this conversation's model; left out (no app-server), the box has no pill. */
  onPickModel?: (rt: Runtime, selection: ModelSelection) => Promise<void>;
  /** The conversation's Inbox item, when it has one: its unread boundary, last message day and notice. */
  item?: AttentionItem | null;
  /** The card is still actionable: offer Mark as done. */
  waiting: boolean;
  /** "Mac unreachable · last seen …": takes the notice's place, over the box, so the thread stays readable. */
  banner?: ReactNode;
  /** Where back goes, as a word, for the back control's name. */
  backLabel?: string;
  /** Text the host wants in the reply box (an "ask the agent to…" from the agent's page); a new tick replaces the draft, as the desktop chat does. */
  prefill?: { text: string; tick: number } | null;
  /** The desk's pin state, when the mod knows this conversation as a desk; null hides the action. */
  pinned?: boolean | null;
  onPin?: (pinned: boolean) => void;
  onBack: () => void;
  onLoad: (rt: Runtime) => void;
  onDecide: (rt: Runtime, requestId: string, behavior: "allow" | "deny") => void;
  onAnswer: (rt: Runtime, requestId: string, answers: Record<string, string | string[]>) => void;
  onSend: (rt: Runtime, text: string, images: ImageAttachment[], desk: string | null) => void;
  /** Done: the Inbox's clear (seen_mark). */
  onSeen: (rt: Runtime) => void;
  /** Not done: the Inbox's undo (seen_unmark); left out, the sheet does not offer it. */
  onNotDone?: (item: AttentionItem) => void;
  /** A look, not done (viewed_mark): sent on open and for each new message while the screen is up. */
  onViewed?: (agentId: string, conversationId: string) => void;
}) {
  const rt: Runtime = { agent_id: thread.agentId, conversation_id: thread.conversationId };
  const [draft, setDraft] = useDraft(draftKey(thread.agentId, thread.conversationId));
  const [actionsOpen, setActionsOpen] = useState(false);

  useEffect(() => {
    onLoad(rt);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [thread.agentId, thread.conversationId]);

  const agentName = thread.agentName ?? "the agent";
  const people = useMemo(() => ({ assistant: { name: thread.agentName ?? "agent", avatar: avatarUrl(thread.agentId) }, user: { name: "You" } }), [thread.agentName, thread.agentId]);
  // Viewed, not done: open is a look; the New line goes before what came since the look from before this open.
  const heldLook = useViewed(keyOf(thread.agentId, thread.conversationId), item, !!onViewed, onViewed ?? noop);
  const dividerAt = unreadBoundary(view.rows, item?.unread ?? false, item?.seenAt, heldLook);
  const layout = useMemo(() => ({ people, dividerAt, dividerDay: dayLabel(item?.lastMessageAt) }), [people, dividerAt, item?.lastMessageAt]);
  const said = threadNotice(item, waiting, view.status, thread.agentName);
  const notice =
    banner ??
    (said && (
      <div className="loki-phone-notice" role="status">
        <span className="loki-phone-ellipsis">{said}</span>
      </div>
    ));
  const canSee = waiting && !view.pending;
  const canUndo = !!onNotDone && !!item && doneAction(item) === "undone";

  return (
    <>
      <ThreadHeader thread={thread} view={view} waiting={waiting} backLabel={backLabel} onBack={onBack} onActions={() => setActionsOpen(true)} />
      {/* The phone's column is the reading measure (phone.css lifts the desktop's bubble cap under this class). */}
      <div className="loki-phone-thread loki-phone-convo-body">
        <Conversation
          touch
          dim={false}
          gutter={{ left: "var(--phone-safe-left)", right: "var(--phone-safe-right)", bottom: "var(--phone-safe-bottom)" }}
          view={{ rows: view.rows, status: view.status, error: view.error, model, reasoningEffort, approval: view.pending, question: view.question }}
          models={models}
          actions={{
            onLoadModels,
            onPickModel: onPickModel ? (selection) => onPickModel(rt, selection) : undefined,
            onSend: (text, images = []) => onSend(rt, text, images, thread.title),
            onAnswer: view.question ? (answers) => onAnswer(rt, view.question!.requestId, answers) : undefined,
            onApprove: view.pending ? (behavior) => onDecide(rt, view.pending!.requestId, behavior) : undefined,
          }}
          agentName={agentName}
          prefill={prefill}
          layout={layout}
          notice={notice || null}
          placeholder={view.question ? "Answer, or pick above" : view.pending ? "Reply, or decide below" : `Message ${agentName}`}
          draft={{ value: draft, onChange: setDraft }}
        />
      </div>
      {actionsOpen && (
        <Sheet label={`${thread.title ?? agentName} actions`} onClose={() => setActionsOpen(false)} placement="bottom" className="loki-phone-sheet">
          <ul className="loki-phone-list">
            {canSee && <SheetRow icon="check" label="Mark as done" onClick={() => (onSeen(rt), setActionsOpen(false))} />}
            {canUndo && <SheetRow icon="history" label="Mark as not done" onClick={() => (onNotDone!(item!), setActionsOpen(false))} />}
            {pinned !== null && onPin && <SheetRow icon="pin" label={pinned ? "Unpin" : "Pin to the top"} onClick={() => (onPin(!pinned), setActionsOpen(false))} />}
            <SheetRow icon="person" label={`${thread.agentName ?? "Agent"}'s profile`} onClick={() => (setActionsOpen(false), navigate({ kind: "agent", agentId: thread.agentId }))} />
          </ul>
          <Button size="touch" tone="paper" block onClick={() => setActionsOpen(false)}>
            Cancel
          </Button>
        </Sheet>
      )}
    </>
  );
}

/**
 * The header, Slack's DM bar: a back circle, the identity pill (the agent's face with its working dot, its
 * name, and "working · <desk>" under it; a tap opens the agent's profile), and a circle for the actions sheet.
 * The heading wraps the pill so focus lands on the conversation's name when the page opens.
 */
function ThreadHeader({ thread, view, waiting, backLabel, onBack, onActions }: { thread: Thread; view: ThreadView; waiting: boolean; backLabel: string; onBack: () => void; onActions: () => void }) {
  const name = thread.agentName ?? "agent";
  const line = threadLine({ status: view.status, approval: view.pending, question: view.question, waiting, desk: thread.title });
  const working = view.status !== "idle";
  return (
    <header className="loki-phone-convo-head">
      <button type="button" className="loki-phone-circle" onClick={onBack} aria-label={`Back to ${backLabel}`}>
        <Icon name="back" size={22} />
      </button>
      <h1 className="loki-phone-convo-heading" data-phone-heading tabIndex={-1}>
        <button type="button" className="loki-phone-convo-who" onClick={() => navigate({ kind: "agent", agentId: thread.agentId })} aria-label={`${name}${line ? `, ${line}` : ""}. Open profile`}>
          <Avatar name={thread.agentName} src={avatarUrl(thread.agentId)} size={32} presence={working} />
          <span className="loki-phone-convo-copy">
            <span className="loki-phone-convo-name loki-phone-ellipsis">{name}</span>
            {line && <span className="loki-phone-convo-line loki-phone-ellipsis">{line}</span>}
          </span>
        </button>
      </h1>
      <button type="button" className="loki-phone-circle" onClick={onActions} aria-label="Conversation actions" aria-haspopup="dialog">
        <Icon name="more" size={22} />
      </button>
    </header>
  );
}
