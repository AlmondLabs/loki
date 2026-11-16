import { linksSeenFrom, type ChatLink } from "../../../core/chat-links.ts";
import { LinkHeader } from "../chat/link-header";
import { useEffect, useEffectEvent, useState, type ComponentProps, type ReactNode } from "react";
import type { LabelView } from "../../../core/labels.ts";
import { LabelsSheet } from "./labels-sheet";
import type { Runtime } from "../../../core/attention/protocol.ts";
import { keyOf, type AttentionItem, type PendingApproval, type PendingQuestion } from "../../../core/attention/model.ts";
import type { Attachment } from "../../../core/attention/content.ts";
import type { ChatEngineView, ModelSelection, ReasoningEffort } from "../../../core/models.ts";
import type { ModelEntry } from "../chat/model-picker";
import { OpenChat } from "../chat/transcript";
import type { WholeRow } from "../../../core/attention/transcript.ts";
import { Conversation, type ChatStatus, type ConversationView } from "../chat/conversation";
import type { SuggestionsProps } from "../chat/suggestion-card";
import { useThreadRows, type ChatViews } from "../../../core/attention/use-attention.ts";
import { avatarUrl } from "../desk/env";
import { Button, Sheet } from "../components";
import { threadNotice } from "./deck";
import { ThreadNotice, replyPlaceholder, useThreadLayout } from "./thread-parts";
import { useMessageActions } from "./use-message-actions";
import { SheetRow } from "./home";
import { RenameSheet } from "./rename-sheet";
import { FolderSheet } from "./folder-sheet";
import { useViewed } from "../shared/use-viewed";
import { doneAction } from "../shell/sidebar-model";
import { Icon } from "./icons";
import { threadLine } from "./model";
import { navigate, openConversation } from "./router";
import { Avatar } from "./rows";
import { draftKey, useDraft } from "../shared/drafts";

const noop = () => {};

export interface Thread {
  agentId: string;
  conversationId: string;
  title: string | null;
  agentName: string | null;
}

export interface ThreadView {
  status: ChatStatus;
  pending: PendingApproval | null;
  question: PendingQuestion | null;
  error: string | null;
  engine?: ChatEngineView | null;
  older?: (() => void) | null;
  loadFailed?: (() => void) | null;
  loadStep?: (row: number) => Promise<WholeRow | null>;
  links?: ChatLink[];
}

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
  backLabel = "flow",
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
  suggestions = null,
  onCloseLink,
}: {
  thread: Thread;
  view: ThreadView;
  chats: Pick<ChatViews, "watchThreads" | "threadRows">;
  model?: string | null;
  reasoningEffort?: ReasoningEffort | null;
  models?: ModelEntry[] | null;
  onLoadModels?: () => void;
  onPickModel?: (rt: Runtime, selection: ModelSelection) => Promise<void>;
  item?: AttentionItem | null;
  waiting: boolean;
  banner?: ReactNode;
  backLabel?: string;
  prefill?: { text: string; tick: number } | null;
  pinned?: boolean | null;
  onPin?: (pinned: boolean) => void;
  rename?: {
    name: string;
    onRename: ((name: string) => Promise<string | null>) | null;
    onPurpose?: ((purpose: string) => Promise<string | null>) | null;
  } | null;
  purpose?: string | null;
  archive?: { archived: boolean; onArchive: ((archived: boolean) => Promise<string | null>) | null } | null;
  labels?: { current: string[]; list: LabelView[] | null; onChange: ((labels: string[]) => Promise<string | null>) | null } | null;
  folder?: { load: () => Promise<{ current: string | null; choices: string[] }>; onMove: (folder: string) => Promise<string | null> } | null;
  onBack: () => void;
  onLoad: (rt: Runtime) => void;
  onDecide: (rt: Runtime, requestId: string, behavior: "allow" | "deny" | "always") => void;
  onStop?: (rt: Runtime) => Promise<string | null>;
  onAnswer: (rt: Runtime, requestId: string, answers: Record<string, string | string[]>) => void;
  onSend: (rt: Runtime, text: string, images: Attachment[], desk: string | null) => void;
  onSeen: (rt: Runtime) => void;
  onNotDone?: (item: AttentionItem) => void;
  onViewed?: (agentId: string, conversationId: string) => void;
  suggestions?: Omit<SuggestionsProps, "rt"> | null;
  onCloseLink?: (rt: Runtime, linkId: string) => void;
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
    if (!archive.archived) onBack();
  };

  const load = useEffectEvent(() => onLoad(rt));
  useEffect(() => load(), [thread.agentId, thread.conversationId]);

  const agentName = thread.agentName ?? "the agent";
  const heldLook = useViewed(keyOf(thread.agentId, thread.conversationId), item, !!onViewed, onViewed ?? noop);
  const message = useMessageActions({ user: "You", assistant: thread.agentName ?? "Agent" });
  const said = threadNotice(item, waiting, view.status, thread.agentName);
  const notice = banner ?? (said && <ThreadNotice text={said} status />);
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
      {view.links?.length ? (
        <div className="loki-phone-links">
          <LinkHeader links={linksSeenFrom(view.links, rt)} onClose={onCloseLink ? (id) => onCloseLink(rt, id) : undefined} touch />
        </div>
      ) : null}
      <div className="loki-phone-thread loki-phone-convo-body">
        {message.wrap(
          <ScreenThread
            chats={chats}
            thread={thread}
            item={item}
            heldLook={heldLook}
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
            placeholder={replyPlaceholder(!!view.question, !!view.pending, agentName)}
            draft={{ value: draft, onChange: setDraft }}
            suggestions={suggestions ? { ...suggestions, rt } : null}
          />,
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

function ScreenThread({
  chats,
  thread,
  item,
  heldLook,
  view,
  ...conversation
}: Omit<ComponentProps<typeof Conversation>, "view" | "layout" | "touch" | "dim" | "gutter"> & {
  chats: Pick<ChatViews, "watchThreads" | "threadRows">;
  thread: Thread;
  item: AttentionItem | null;
  heldLook: string | null;
  view: Omit<ConversationView, "rows">;
}) {
  const rows = useThreadRows(chats, thread.agentId, thread.conversationId);
  const layout = useThreadLayout(thread, rows, item, heldLook);
  return (
    <OpenChat.Provider value={openConversation}>
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
