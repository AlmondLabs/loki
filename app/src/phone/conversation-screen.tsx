import { useEffect, useEffectEvent, useMemo, useState, type ComponentProps, type ReactNode } from "react";
import { useInlineWidgets } from "../chat/use-inline-widgets";
import type { LabelView } from "../../../core/labels.ts";
import { LabelsSheet } from "./labels-sheet";
import { scopeFor } from "../../../core/desk-core.ts";
import type { Runtime } from "../../../core/attention/protocol.ts";
import { keyOf, type AttentionItem, type PendingApproval, type PendingQuestion } from "../../../core/attention/model.ts";
import type { Attachment } from "../../../core/attention/content.ts";
import type { ChatEngineView, ModelSelection, ReasoningEffort } from "../../../core/models.ts";
import type { ModelEntry } from "../chat/model-picker";
import { OpenChat, type MessageLayout } from "../chat/transcript";
import type { WholeRow } from "../../../core/attention/transcript.ts";
import { Conversation, type ChatStatus, type ConversationView } from "../chat/conversation";
import type { SuggestionsProps } from "../chat/suggestion-card";
import { useThreadRows, type ChatViews } from "../../../core/attention/use-attention.ts";
import { avatarUrl } from "../desk/env";
import { Button, Sheet } from "../components";
import { dayLabel, threadNotice, unreadBoundary } from "./deck";
import { useMessageActions } from "./use-message-actions";
import { MessageTasks, useMessageTasksScope, type TaskApi } from "../tasks/message-tasks";
import { SheetRow } from "./home";
import { RenameSheet } from "./rename-sheet";
import { FolderSheet } from "./folder-sheet";
import { useViewed } from "../shared/use-viewed";
import { doneAction } from "../shell/sidebar-model";
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

/**
 * What the phone's conversation page shows of a chat besides its rows: what the agent is doing, the approval or
 * question waiting, the turn's error, and a way to load older rows when there are any. The rows are read by the
 * thread itself (ScreenThread), so a streamed piece redraws the thread and not the page around it (plan 032).
 */
export interface ThreadView {
  status: ChatStatus;
  pending: PendingApproval | null;
  question: PendingQuestion | null;
  error: string | null;
  /** The ACP agent the chat runs on (plan 020), whose models the picker offers once the chat has started. */
  engine?: ChatEngineView | null;
  older?: (() => void) | null;
  /** The thread's first page did not come (plan 041): try again. */
  loadFailed?: (() => void) | null;
  /** Fetch what a history page left out of a lean row: a tool row's step (plan 041), an event's detail (plan 043). */
  loadStep?: (row: number) => Promise<WholeRow | null>;
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
  chats,
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
  rename = null,
  purpose = null,
  archive = null,
  labels = null,
  folder = null,
  onBack,
  onLoad,
  onDecide,
  onStop,
  onAnswer,
  onSend,
  onSeen,
  onNotDone,
  onViewed,
  taskApi = null,
  suggestions = null,
}: {
  thread: Thread;
  view: ThreadView;
  /** Where the thread's rows are read (useAttention's), by ScreenThread. */
  chats: Pick<ChatViews, "watchThreads" | "threadRows">;
  /** The model the conversation runs on (the mod's desks list) and its effort; null when not known. */
  model?: string | null;
  reasoningEffort?: ReasoningEffort | null;
  /** list_models, for the pill's name and Select model; loaded on the first ask. */
  models?: ModelEntry[] | null;
  onLoadModels?: () => void;
  /** Switch this conversation's model; left out (no link to the daemon), the box has no pill. */
  onPickModel?: (rt: Runtime, selection: ModelSelection) => Promise<void>;
  /** The conversation's Inbox item, when it has one: its unread boundary, last message day and notice. */
  item?: AttentionItem | null;
  /** The chat has something new for you: offer Mark as read. */
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
  /** Rename, when this is a desk of its own (not a main chat); `onRename` null while the daemon cannot take it. */
  rename?: {
    name: string;
    onRename: ((name: string) => Promise<string | null>) | null;
    /** Save the purpose line too (plan 047, R11); null or left out, the Rename sheet has no purpose field. */
    onPurpose?: ((purpose: string) => Promise<string | null>) | null;
  } | null;
  /** The person's one line on what the chat is for (plan 047, R11), shown in the header under its name. */
  purpose?: string | null;
  /** Archive (done: the chat leaves the Inbox) or restore, when this chat can be archived; `onArchive` null while the daemon cannot take it. */
  archive?: { archived: boolean; onArchive: ((archived: boolean) => Promise<string | null>) | null } | null;
  /** The chat's labels (plan 022), their colours and saving them; `onChange` null while the daemon cannot take it. */
  labels?: { current: string[]; list: LabelView[] | null; onChange: ((labels: string[]) => Promise<string | null>) | null } | null;
  /** Change folder: the chat's folder and the agent's recent ones, and the move; null while the daemon cannot take it. */
  folder?: { load: () => Promise<{ current: string | null; choices: string[] }>; onMove: (folder: string) => Promise<string | null> } | null;
  onBack: () => void;
  onLoad: (rt: Runtime) => void;
  onDecide: (rt: Runtime, requestId: string, behavior: "allow" | "deny" | "always") => void;
  /** Stop this conversation's turn, so you can take over; resolves to an error or null. */
  onStop?: (rt: Runtime) => Promise<string | null>;
  onAnswer: (rt: Runtime, requestId: string, answers: Record<string, string | string[]>) => void;
  onSend: (rt: Runtime, text: string, images: Attachment[], desk: string | null) => void;
  /** Done: the Inbox's clear (seen_mark). */
  onSeen: (rt: Runtime) => void;
  /** Not done: the Inbox's undo (seen_unmark); left out, the sheet does not offer it. */
  onNotDone?: (item: AttentionItem) => void;
  /** A look, not done (viewed_mark): sent on open and for each new message while the screen is up. */
  onViewed?: (agentId: string, conversationId: string) => void;
  /** Tasks, for Add task in a message's long press and the chips of the messages that have one. */
  taskApi?: TaskApi | null;
  /** The suggestions made in this chat for other chats (plan 047), over the box; null or absent, none. */
  suggestions?: Omit<SuggestionsProps, "rt"> | null;
}) {
  const rt: Runtime = { agent_id: thread.agentId, conversation_id: thread.conversationId };
  const [draft, setDraft] = useDraft(draftKey(thread.agentId, thread.conversationId));
  const [actionsOpen, setActionsOpen] = useState(false);
  const [moving, setMoving] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [labeling, setLabeling] = useState(false);
  const [archiving, setArchiving] = useState<{ busy: boolean; error: string | null }>({ busy: false, error: null });
  const toggleArchive = async () => {
    if (!archive?.onArchive) return;
    setArchiving({ busy: true, error: null });
    const err = await archive.onArchive(!archive.archived);
    setArchiving({ busy: false, error: err });
    if (err) return;
    setActionsOpen(false);
    if (!archive.archived) onBack(); // archived: done with it, back to where you came from
  };

  const load = useEffectEvent(() => onLoad(rt));
  useEffect(() => load(), [thread.agentId, thread.conversationId]);

  const agentName = thread.agentName ?? "the agent";
  const people = useMemo(
    () => ({ assistant: { name: thread.agentName ?? "agent", avatar: avatarUrl(thread.agentId) }, user: { name: "You" } }),
    [thread.agentName, thread.agentId],
  );
  // Viewed, not done: open is a look; the New line goes before what came since the look from before this open.
  const heldLook = useViewed(keyOf(thread.agentId, thread.conversationId), item, !!onViewed, onViewed ?? noop);
  const messageTasks = useMessageTasksScope(
    { agentId: thread.agentId, agentName: thread.agentName, conversationId: thread.conversationId, desk: scopeFor(thread.conversationId, thread.agentId) },
    taskApi,
  );
  const message = useMessageActions({ user: "You", assistant: thread.agentName ?? "Agent" }, messageTasks?.start);
  const said = threadNotice(item, waiting, view.status, thread.agentName);
  const notice =
    banner ??
    (said && (
      <div className="loki-phone-notice" role="status">
        <span className="loki-phone-ellipsis">{said}</span>
      </div>
    ));
  const canSee = waiting && !view.pending;
  const asked = view.question;
  const approval = view.pending;
  const canUndo = !!onNotDone && !!item && doneAction(item) === "undone";

  return (
    <>
      <ThreadHeader
        thread={thread}
        view={view}
        waiting={waiting}
        purpose={purpose}
        backLabel={backLabel}
        onBack={onBack}
        onActions={() => setActionsOpen(true)}
      />
      {/* The phone's column is the reading measure (phone.css lifts the desktop's bubble cap under this class). */}
      <div className="loki-phone-thread loki-phone-convo-body">
        {message.wrap(
          <MessageTasks.Provider value={messageTasks}>
            <ScreenThread
              chats={chats}
              thread={thread}
              item={item}
              heldLook={heldLook}
              people={people}
              view={{
                status: view.status,
                error: view.error,
                model,
                reasoningEffort,
                engine: view.engine ?? null,
                approval: view.pending,
                question: view.question,
                older: view.older ?? null,
                loadFailed: view.loadFailed ?? null,
                loadStep: view.loadStep,
              }}
              models={models}
              actions={{
                onLoadModels,
                onPickModel: onPickModel ? (selection) => onPickModel(rt, selection) : undefined,
                onSend: (text, images = []) => onSend(rt, text, images, thread.title),
                onAnswer: asked ? (answers) => onAnswer(rt, asked.requestId, answers) : undefined,
                onApprove: approval ? (behavior) => onDecide(rt, approval.requestId, behavior) : undefined,
                onStop: onStop ? () => onStop(rt) : undefined,
              }}
              agentName={agentName}
              prefill={prefill}
              notice={notice || null}
              placeholder={view.question ? "Answer, or pick above" : view.pending ? "Reply, or decide below" : `Message ${agentName}`}
              draft={{ value: draft, onChange: setDraft }}
              suggestions={suggestions ? { ...suggestions, rt } : null}
            />
          </MessageTasks.Provider>,
        )}
      </div>
      {message.sheet}
      {actionsOpen && (
        <Sheet label={`${thread.title ?? agentName} actions`} onClose={() => setActionsOpen(false)} placement="bottom" className="loki-phone-sheet">
          <ul className="loki-phone-list">
            {canSee && <SheetRow icon="check" label="Mark as read" onClick={() => (onSeen(rt), setActionsOpen(false))} />}
            {canUndo && <SheetRow icon="history" label="Mark as unread" onClick={() => (onNotDone(item), setActionsOpen(false))} />}
            {pinned !== null && onPin && (
              <SheetRow icon="pin" label={pinned ? "Unpin" : "Pin to the top"} onClick={() => (onPin(!pinned), setActionsOpen(false))} />
            )}
            {rename && (
              <SheetRow
                icon="pencil"
                label="Rename"
                aside={rename.onRename ? null : "Not connected"}
                disabled={!rename.onRename}
                onClick={() => (setActionsOpen(false), setRenaming(true))}
              />
            )}
            {labels && (
              <SheetRow
                icon="filter"
                label={labels.current.length ? `Labels · ${labels.current.join(", ")}` : "Labels"}
                aside={labels.onChange ? null : "Not connected"}
                disabled={!labels.onChange}
                onClick={() => (setActionsOpen(false), setLabeling(true))}
              />
            )}
            {folder && <SheetRow icon="folder" label="Change folder" onClick={() => (setActionsOpen(false), setMoving(true))} />}
            {archive && (
              <SheetRow
                icon="archive"
                label={archiving.busy ? (archive.archived ? "Restoring…" : "Archiving…") : archive.archived ? "Restore" : "Archive"}
                aside={archive.onArchive ? null : "Not connected"}
                disabled={!archive.onArchive || archiving.busy}
                onClick={() => void toggleArchive()}
              />
            )}
            <SheetRow
              icon="person"
              label={`${thread.agentName ?? "Agent"}'s profile`}
              onClick={() => (setActionsOpen(false), navigate({ kind: "agent", agentId: thread.agentId }))}
            />
          </ul>
          {archiving.error && (
            <p role="alert" className="loki-phone-error">
              {archiving.error}
            </p>
          )}
          <Button size="touch" tone="paper" block onClick={() => setActionsOpen(false)}>
            Cancel
          </Button>
        </Sheet>
      )}
      {moving && folder && <FolderSheet load={folder.load} onMove={folder.onMove} onClose={() => setMoving(false)} />}
      {renaming && rename?.onRename && (
        <RenameSheet
          name={rename.name}
          onRename={rename.onRename}
          onClose={() => setRenaming(false)}
          purpose={purpose}
          onPurpose={rename.onPurpose ?? undefined}
        />
      )}
      {labeling && labels?.onChange && (
        <LabelsSheet current={labels.current} list={labels.list} onChange={labels.onChange} onClose={() => setLabeling(false)} />
      )}
    </>
  );
}

/**
 * The page's thread and box: the one part of the page that reads the chat's rows (plan 032), so a streamed piece
 * redraws it and not the header, the sheets or the page around it. The New line and the widget rows come from the
 * rows, so they are worked out here.
 */
function ScreenThread({
  chats,
  thread,
  item,
  heldLook,
  people,
  view,
  ...conversation
}: Omit<ComponentProps<typeof Conversation>, "view" | "layout" | "touch" | "dim" | "gutter"> & {
  chats: Pick<ChatViews, "watchThreads" | "threadRows">;
  thread: Thread;
  item: AttentionItem | null;
  heldLook: string | null;
  people: MessageLayout["people"];
  view: Omit<ConversationView, "rows">;
}) {
  const rows = useThreadRows(chats, thread.agentId, thread.conversationId);
  const dividerAt = unreadBoundary(rows, item?.unread ?? false, item?.seenAt, heldLook);
  const { widgets, inline } = useInlineWidgets(undefined, scopeFor(thread.conversationId, thread.agentId), rows, thread.agentName ?? null, {
    readOnly: true,
  });
  const layout = useMemo(
    () => ({ people, dividerAt, dividerDay: dayLabel(item?.last_message_at), widgets, inline }),
    [people, dividerAt, item?.last_message_at, widgets, inline],
  );
  return (
    <OpenChat.Provider value={openChat}>
      <Conversation
        {...conversation}
        touch
        dim={false}
        gutter={{ left: "var(--phone-safe-left)", right: "var(--phone-safe-right)", bottom: "var(--phone-safe-bottom)" }}
        view={{ ...view, rows }}
        layout={layout}
      />
    </OpenChat.Provider>
  );
}

/** A chip naming another chat (a message sent from a suggestion) opens that chat's page. */
const openChat = (agentId: string, conversationId: string) => navigate({ kind: "conversation", agentId, conversationId, prefill: null });

/**
 * The header, Slack's DM bar: a back circle, the identity pill (the agent's face with its working dot, its
 * name, "working · <desk>" under it and the chat's purpose under that; a tap opens the agent's profile), and a circle for the actions sheet.
 * The heading wraps the pill so focus lands on the conversation's name when the page opens.
 */
function ThreadHeader({
  thread,
  view,
  waiting,
  purpose,
  backLabel,
  onBack,
  onActions,
}: {
  thread: Thread;
  view: ThreadView;
  waiting: boolean;
  purpose: string | null;
  backLabel: string;
  onBack: () => void;
  onActions: () => void;
}) {
  const name = thread.agentName ?? "agent";
  const line = threadLine({ status: view.status, approval: view.pending, question: view.question, waiting, desk: thread.title });
  const working = view.status !== "idle";
  return (
    <header className="loki-phone-convo-head">
      <button type="button" className="loki-phone-circle" onClick={onBack} aria-label={`Back to ${backLabel}`}>
        <Icon name="back" size={22} />
      </button>
      <h1 className="loki-phone-convo-heading" data-phone-heading tabIndex={-1}>
        <button
          type="button"
          className="loki-phone-convo-who"
          onClick={() => navigate({ kind: "agent", agentId: thread.agentId })}
          aria-label={`${name}${line ? `, ${line}` : ""}. Open profile`}
        >
          <Avatar name={thread.agentName} src={avatarUrl(thread.agentId)} size={32} presence={working} />
          <span className="loki-phone-convo-copy">
            <span className="loki-phone-convo-name loki-phone-ellipsis">{name}</span>
            {line && <span className="loki-phone-convo-line loki-phone-ellipsis">{line}</span>}
            {purpose && <span className="loki-phone-convo-line loki-phone-ellipsis">{purpose}</span>}
          </span>
        </button>
      </h1>
      <button type="button" className="loki-phone-circle" onClick={onActions} aria-label="Conversation actions" aria-haspopup="dialog">
        <Icon name="more" size={22} />
      </button>
    </header>
  );
}
