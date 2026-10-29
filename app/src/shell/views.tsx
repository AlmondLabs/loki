import { lazy, Suspense, type RefObject } from "react";
import { conversationDirName, scopeFor } from "../../../core/desk-core.ts";
import { LOKI_COMMANDS } from "../../../core/attention/commands.ts";
import { labelCommand } from "../chat/labels";
import { saveLabels } from "../desk/desk-conversation";
import { runAction } from "./keymap";
import { lastInput } from "../kit/motion";
import { CatchUp as Inbox, type PassSummaryHandler } from "../desk/catch-up";
import { NewDesk } from "../desk/new-desk";
import { TasksPane } from "../tasks/tasks-pane";
import { Agents } from "../agents/agents";
import { Recall } from "../recall/recall";
import type { Recall as RecallModel } from "./use-recall";
import { avatarUrl } from "../desk/env";
import type { ModelEntry } from "../chat/model-picker";
import type { ChatPlacement, ChatWidth } from "../chat/chat-window";

import { DeskTree } from "./desk-tree";
import { Welcome } from "./welcome";
import type { DaemonStatus } from "./bootstrap";
import type { LokiUpdate } from "./use-loki-update";
import type { GlobalShortcut } from "./use-global-shortcut";
import type { AssignTarget, useTasks } from "./use-tasks";
import type { CatchUp, Desk, Runtime } from "./types";
import type { ModelSelection } from "../../../core/models.ts";
import type { DeskSummary, Task } from "../../../core/frame-types.ts";

/**
 * The views the rail switches between, each a thin wrapper that wires the window's models to one
 * component. Shell keeps the state; these keep the plumbing.
 */

type OpenDesk = (agentId: string, conversationId: string, opts?: { chat?: boolean }) => void;
type PickModel = (scope: string, rt: Runtime, selection: ModelSelection) => Promise<void>;
type PickMode = (scope: string, rt: Runtime, mode: string) => Promise<void>;

/** Recall: the review deck, the card list and the deleted pile, over the mod's files. */
export function RecallView({
  recall,
  active,
  onOpenDesk,
  onBegin,
}: {
  recall: RecallModel;
  active: boolean;
  onOpenDesk: OpenDesk;
  onBegin: (agentId: string, conversationId: string, brief: string, title: string) => void;
}) {
  return (
    <Recall recall={recall} active={active} onOpenDesk={(agentId, conversationId) => onOpenDesk(agentId, conversationId, { chat: true })} onBegin={onBegin} />
  );
}

/** How the Inbox's last move was made, for analytics: the last input was a key or a click. */
const via = () => (lastInput() === "key" ? "key" : "click");

/** The inbox: every conversation's cards, with the model and mode pickers per conversation. */
export function InboxView({
  desk,
  catchUp,
  models,
  onLoadModels,
  onPickModel,
  onPickMode,
  onOpenDesk,
  onClose,
  onPass,
  notice,
}: {
  desk: Desk;
  catchUp: CatchUp;
  /** A one-line message at the bottom of the window (a refused `/label`). */
  notice: (message: string) => void;
  models: ModelEntry[] | null;
  onLoadModels: () => void;
  onPickModel: PickModel;
  onPickMode: PickMode;
  onOpenDesk: OpenDesk;
  onClose: () => void;
  onPass: PassSummaryHandler;
}) {
  return (
    <Inbox
      open
      onClose={onClose}
      onPass={onPass}
      items={catchUp.items}
      labelList={catchUp.labels.list}
      onSeen={(item, moved) => (moved === "next" && catchUp.decided(item, "next", via()), catchUp.seen(item))}
      onUnread={(item) => (catchUp.undone(item, "next"), catchUp.unread(item))}
      onArchive={(item) => (catchUp.decided(item, "archive", via()), catchUp.archive(item))}
      onUnarchive={(item) => (catchUp.undone(item, "archive"), void catchUp.unarchive(item))}
      onApprove={(item, requestId, behavior) => (
        catchUp.decided(item, behavior !== "deny" ? "approve" : "deny", via()),
        catchUp.approve(item, requestId, behavior)
      )}
      onAnswer={(item, requestId, answers) => (catchUp.decided(item, "answer", via()), catchUp.answer(item.runtime, requestId, answers))}
      onReply={(item, text, images) => (catchUp.decided(item, "reply", via()), catchUp.reply(item, text, images))}
      onStop={(item) => catchUp.stop(item.runtime)}
      onShown={catchUp.shown}
      onFilter={catchUp.filtered}
      onOpenDesk={(agentId, conversationId) => {
        const item = catchUp.items.find((i) => i.agent_id === agentId && i.id === conversationId);
        if (item) catchUp.decided(item, "open", via());
        onOpenDesk(agentId, conversationId, { chat: true });
      }}
      chats={catchUp}
      loadHistory={(item) => void catchUp.loadHistory(item)}
      widgetSource={desk}
      modelFor={(agentId, conversationId) => desk.modelOf(scopeFor(conversationId, agentId))}
      reasoningEffortFor={(agentId, conversationId) => desk.reasoningEffortOf(scopeFor(conversationId, agentId))}
      models={models}
      onLoadModels={onLoadModels}
      onPickModel={(item, selection) => onPickModel(scopeFor(item.id, item.agent_id), item.runtime, selection)}
      modeFor={(agentId, conversationId) => desk.modeOf(scopeFor(conversationId, agentId))}
      onPickMode={(item, mode) => onPickMode(scopeFor(item.id, item.agent_id), item.runtime, mode)}
      commands={catchUp.commands}
      onCommand={(item, id, args) => {
        // loki's own commands are keymap actions; everything else is the daemon's, run for the card's conversation.
        const local = LOKI_COMMANDS.find((c) => c.id === id);
        if (id === "label") {
          const current = desk.desks.list.find((d) => d.scope === scopeFor(item.id, item.agent_id))?.labels ?? [];
          void labelCommand(args, current, (next) => saveLabels(desk, catchUp, item.runtime, next)).then((err) => err && notice(`labels: ${err}`));
        } else if (local?.action) runAction(local.action);
        else void catchUp.execute(item.runtime, id, args);
      }}
    />
  );
}

/**
 * Tasks: the list from useTasks, with its moves; ⏎ / ⌘⏎ ask the picker for a target. A message chip's ask for a task
 * (focus) mounts the pane afresh on it: no filter, no selection, the cursor there.
 */
export function TasksView({
  tasks,
  desks,
  onAssign,
  onNew,
  focus,
  onOpenSource,
  active,
}: {
  tasks: ReturnType<typeof useTasks>;
  desks: DeskSummary[];
  onAssign: (ids: string[], start: boolean) => void;
  onNew: () => void;
  focus: { id: string; tick: number } | null;
  onOpenSource: (task: Task) => void;
  active: boolean;
}) {
  return (
    <TasksPane
      tasks={tasks.list}
      loading={tasks.loading}
      error={tasks.error}
      desks={desks}
      onRefresh={() => void tasks.refresh()}
      onAssign={onAssign}
      onClose={(ids) => void tasks.closeTasks(ids)}
      onReopen={(ids) => void tasks.reopenTasks(ids)}
      onStatus={(ids, status) => void tasks.setTaskStatus(ids, status)}
      onNew={onNew}
      key={focus?.tick ?? 0}
      focusId={focus?.id ?? null}
      onOpenSource={onOpenSource}
      active={active}
    />
  );
}

/** The agents: profile, memory, changes and skills per agent; "ask to update" opens the main chat with a request typed in. */
export function AgentsView({
  desk,
  catchUp,
  tasks,
  onOpenDesk,
  onAskToUpdate,
  onShowDesks,
  onShowTasks,
}: {
  desk: Desk;
  catchUp: CatchUp;
  tasks: ReturnType<typeof useTasks>["list"];
  onOpenDesk: OpenDesk;
  onAskToUpdate: (agentId: string, text: string) => void;
  onShowDesks: () => void;
  onShowTasks: () => void;
}) {
  return (
    <Agents
      columnOutside
      agents={catchUp.agents}
      api={desk.agents}
      avatar={avatarUrl}
      desks={desk.desks.list}
      tasks={tasks}
      initialAgentId={desk.agentId}
      onOpenDesk={(agentId, conversationId) => onOpenDesk(agentId, conversationId, { chat: true })}
      onAskToUpdate={onAskToUpdate}
      onUpdateAgent={catchUp.updateAgent}
      write={{
        createAgent: catchUp.createAgent,
        deleteAgent: catchUp.deleteAgent,
        writeMemory: desk.calls.memory.write,
        removeMemory: desk.calls.memory.remove,
        revertMemory: desk.calls.memory.revert,
      }}
      reflect={catchUp.reflection}
      listModels={catchUp.listModels}
      onShowDesks={onShowDesks}
      onShowTasks={onShowTasks}
      mcp={desk.calls.mcp}
      macs={desk.macs.view ? [desk.macs.view.me, ...desk.macs.view.peers] : undefined}
    />
  );
}

/** The Settings sheet, loaded the first time it opens (plan 038): it is opened now and then, and is a large part of the page. */
const Preferences = lazy(() => import("../settings/settings").then((m) => ({ default: m.Preferences })));

/** Preferences (the Settings sheet): the daemon and mod facts come from the two models and the shell; the chat preferences from useChatLayout. */
export function SettingsView({
  desk,
  catchUp,
  daemon,
  chatWidth,
  onChatWidth,
  chatPlacement,
  onChatPlacement,
  onModelsChanged,
  update,
  shortcut,
  recall,
  onClose,
}: {
  onClose: () => void;
  update: LokiUpdate;
  shortcut: GlobalShortcut;
  recall: RecallModel;
  desk: Desk;
  catchUp: CatchUp;
  daemon: DaemonStatus | null;
  chatWidth: ChatWidth;
  onChatWidth: (w: ChatWidth) => void;
  chatPlacement: ChatPlacement;
  onChatPlacement: (p: ChatPlacement) => void;
  onModelsChanged: () => void;
}) {
  // Nothing while the sheet's chunk loads: a moment on the Mac, where it is read from disk.
  return (
    <Suspense fallback={null}>
      <Preferences
        onClose={onClose}
        chatLink={catchUp.status === "off" ? "connecting" : catchUp.status}
        modConnection={desk.connection}
        deskCount={desk.desks.list.filter((d) => d.status === "live").length}
        chatWidth={chatWidth}
        onChatWidth={onChatWidth}
        chatPlacement={chatPlacement}
        onChatPlacement={onChatPlacement}
        providers={catchUp.providers}
        onLoadProviders={catchUp.loadProviders}
        onConnectProvider={catchUp.connectProvider}
        onDisconnectProvider={catchUp.disconnectProvider}
        onModelsChanged={onModelsChanged}
        daemon={daemon}
        phone={desk.phone}
        macs={desk.macs}
        globalSkills={{ list: desk.agents.globalSkills, enable: desk.calls.skills.enable, disable: desk.calls.skills.disable }}
        mcp={desk.calls.mcp}
        engines={desk.calls.engines}
        labels={{
          list: catchUp.labels.list,
          // A rename or delete changes chats, not just the list: the desks are asked for again so every chip follows.
          edit: async (change) => {
            const err = await catchUp.labels.edit(change);
            if (!err) desk.desks.request();
            return err;
          },
        }}
        update={update}
        shortcut={shortcut}
        recall={recall}
        usage={{ ...desk.usage, agents: catchUp.agents }}
      />
    </Suspense>
  );
}

/** First launch, over the empty desk: Node when the daemon could not start, the provider, the first agent, its desk. */
export function WelcomeView({
  step,
  catchUp,
  daemon,
  onRetryDaemon,
  models,
  onLoadModels,
  onModelsChanged,
  onDone,
}: {
  step: "node" | "provider" | "agent";
  catchUp: CatchUp;
  daemon: DaemonStatus | null;
  onRetryDaemon: () => Promise<void>;
  models: ModelEntry[] | null;
  onLoadModels: () => void;
  onModelsChanged: () => void;
  onDone: (agentId: string) => void;
}) {
  return (
    <Welcome
      step={step}
      providers={catchUp.providers}
      onLoadProviders={catchUp.loadProviders}
      onConnect={catchUp.connectProvider}
      onDisconnect={catchUp.disconnectProvider}
      onModelsChanged={onModelsChanged}
      models={models ? [...new Set(models.map((m) => m.handle))] : null}
      onLoadModels={onLoadModels}
      onCreate={catchUp.createAgent}
      daemon={daemon}
      onRetryDaemon={onRetryDaemon}
      onDone={onDone}
    />
  );
}

/** ⏎ / ⌘⏎ in Tasks: which tasks, and whether to dispatch. Consumed by the picker (or a new desk). */
export interface Picker {
  ids: string[];
  start: boolean;
}

/** The task list's target picker: the desks tree (DeskTree), choosing a target. A new desk carries the tasks along through `pendingAssignRef` (named as a ref so the compiler accepts the write in the handler). */
export function PickerTree({
  picker,
  onClose,
  desk,
  catchUp,
  onAssign,
  pendingAssignRef,
  onNewDesk,
}: {
  picker: Picker | null;
  onClose: () => void;
  desk: Desk;
  catchUp: CatchUp;
  onAssign: (target: AssignTarget, ids: string[], start: boolean) => Promise<void>;
  pendingAssignRef: RefObject<Picker | null>;
  onNewDesk: (agentId: string | null, name: string) => void;
}) {
  return (
    <DeskTree
      open={!!picker}
      onClose={onClose}
      heading={
        picker
          ? `${picker.start ? "Dispatch" : "Assign"} ${picker.ids.length === 1 ? "1 task" : `${picker.ids.length} tasks`} to…${picker.start ? " (the agent starts now)" : ""}`
          : null
      }
      desks={desk.desks.list}
      agents={catchUp.agents}
      items={catchUp.items}
      current={desk.scope}
      onPickDesk={(d) => {
        const p = picker;
        onClose();
        if (p)
          void onAssign({ scope: d.scope, agent_id: d.agent_id, agent_name: d.agent_name, conversation_id: d.conversation_id, title: d.title }, p.ids, p.start);
      }}
      onNew={
        desk.attention.available
          ? (agentId, name) => {
              pendingAssignRef.current = picker;
              onClose();
              onNewDesk(agentId, name);
            }
          : undefined
      }
    />
  );
}

/** The new-desk dialog inherits the open desk's working folder when the mod knows it. */
export function NewDeskSheet({
  state,
  inheritCurrentDesk,
  onClose,
  desk,
  catchUp,
  onCreate,
}: {
  state: { open: boolean; name: string; agentId: string | null };
  inheritCurrentDesk: boolean;
  onClose: () => void;
  desk: Desk;
  catchUp: CatchUp;
  onCreate: (agent: string, folder: string, name: string, home?: string) => Promise<void>;
}) {
  const currentConversationKey = inheritCurrentDesk && desk.conversationId ? conversationDirName(desk.conversationId, desk.agentId) : null;
  return (
    <NewDesk
      open={state.open}
      onClose={onClose}
      agents={catchUp.agents}
      defaultAgentId={state.agentId ?? desk.agentId}
      currentAgentId={inheritCurrentDesk ? desk.agentId : null}
      currentConversationKey={currentConversationKey}
      initialName={state.name}
      folders={desk.attention.folders}
      macs={desk.macs.view}
      requirements={desk.attention.requirements}
      onCreate={onCreate}
    />
  );
}
