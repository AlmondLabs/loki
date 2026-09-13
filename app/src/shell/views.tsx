import type { MutableRefObject } from "react";
import { scopeFor } from "../../../core/desk-core.ts";
import { LOKI_COMMANDS } from "../../../core/attention/commands.ts";
import { runAction } from "./keymap";
import { CatchUp as Inbox } from "../desk/CatchUp";
import { NewDesk } from "../desk/NewDesk";
import { Board } from "../board/Board";
import { Agents } from "../agents/Agents";
import { Recall } from "../recall/Recall";
import type { Recall as RecallModel } from "./useRecall";
import { avatarUrl } from "../desk/env";
import type { ModelEntry } from "../chat/ModelPicker";
import type { ChatPlacement, ChatWidth } from "../chat/ChatWindow";
import type { DeskSummary } from "../desk/useDesk";
import { DeskTree } from "./DeskTree";
import { Settings } from "../settings/Settings";
import { Welcome } from "./Welcome";
import type { BootstrapStatus } from "./bootstrap";
import type { LokiUpdate } from "./useLokiUpdate";
import type { GlobalShortcut } from "./useGlobalShortcut";
import type { AssignTarget, useBoard } from "./useBoard";
import type { CatchUp, Desk, Runtime } from "./types";

/**
 * The views the rail switches between, each a thin wrapper that wires the window's models to one
 * component. Shell keeps the state; these keep the plumbing.
 */

type OpenDesk = (agentId: string, conversationId: string, opts?: { chat?: boolean }) => void;
type PickModel = (scope: string, rt: Runtime, handle: string) => Promise<void>;
type PickMode = (scope: string, rt: Runtime, mode: string) => Promise<void>;

/** Recall: the review deck, the card list and the deleted pile, over the mod's files. */
export function RecallView({ recall, active, onOpenDesk }: { recall: RecallModel; active: boolean; onOpenDesk: OpenDesk }) {
  return <Recall recall={recall} active={active} onOpenDesk={(agentId, conversationId) => onOpenDesk(agentId, conversationId, { chat: true })} />;
}

/** The inbox: every conversation's cards, with the model and mode pickers per conversation. */
export function InboxView({ desk, catchUp, models, onLoadModels, onPickModel, onPickMode, onOpenDesk, onClose }: { desk: Desk; catchUp: CatchUp; models: ModelEntry[] | null; onLoadModels: () => void; onPickModel: PickModel; onPickMode: PickMode; onOpenDesk: OpenDesk; onClose: () => void }) {
  return (
    <Inbox
      open
      onClose={onClose}
      items={catchUp.items}
      onSeen={catchUp.seen}
      onUnread={catchUp.unread}
      onLater={catchUp.later}
      onUnsnooze={catchUp.unsnooze}
      snoozes={catchUp.snoozes}
      onApprove={catchUp.approve}
      onAnswer={(item, requestId, answers) => catchUp.answer(item.runtime, requestId, answers)}
      onReply={catchUp.reply}
      onOpenDesk={(agentId, conversationId) => onOpenDesk(agentId, conversationId, { chat: true })}
      conversation={catchUp.conversation}
      loadHistory={(item) => void catchUp.loadHistory(item)}
      modelFor={(agentId, conversationId) => desk.modelOf(scopeFor(conversationId, agentId))}
      models={models}
      onLoadModels={onLoadModels}
      onPickModel={(item, handle) => onPickModel(scopeFor(item.id, item.agentId), item.runtime, handle)}
      modeFor={(agentId, conversationId) => desk.modeOf(scopeFor(conversationId, agentId))}
      onPickMode={(item, mode) => onPickMode(scopeFor(item.id, item.agentId), item.runtime, mode)}
      commands={catchUp.commands}
      onCommand={(item, id, args) => {
        // loki's own commands are keymap actions; everything else is the harness's, run for the card's conversation.
        const local = LOKI_COMMANDS.find((c) => c.id === id);
        if (local?.action) runAction(local.action);
        else void catchUp.execute(item.runtime, id, args);
      }}
    />
  );
}

/** The board: the task list from useBoard, with its moves; ⏎ / ⌘⏎ ask the picker for a target. */
export function BoardView({ board, desks, onAssign, onNew, active }: { board: ReturnType<typeof useBoard>; desks: DeskSummary[]; onAssign: (ids: string[], start: boolean) => void; onNew: () => void; active: boolean }) {
  return <Board tasks={board.tasks} loading={board.loading} error={board.error} desks={desks} onRefresh={() => void board.refresh()} onAssign={onAssign} onClose={(ids) => void board.closeTasks(ids)} onStatus={(ids, status) => void board.setTaskStatus(ids, status)} onNew={onNew} active={active} />;
}

/** The agents: profile, memory, changes and skills per agent; "ask to update" opens the main chat with a request typed in. */
export function AgentsView({ desk, catchUp, tasks, onOpenDesk, onAskToUpdate, onShowDesks, onShowBoard }: { desk: Desk; catchUp: CatchUp; tasks: ReturnType<typeof useBoard>["tasks"]; onOpenDesk: OpenDesk; onAskToUpdate: (agentId: string, text: string) => void; onShowDesks: () => void; onShowBoard: () => void }) {
  return (
    <Agents
      agents={catchUp.agents}
      api={desk.agents}
      avatar={avatarUrl}
      desks={desk.desks.list}
      tasks={tasks}
      initialAgentId={desk.agentId}
      onOpenDesk={(agentId, conversationId) => onOpenDesk(agentId, conversationId, { chat: true })}
      onAskToUpdate={onAskToUpdate}
      onUpdateAgent={catchUp.updateAgent}
      write={{ createAgent: catchUp.createAgent, deleteAgent: catchUp.deleteAgent, writeMemory: catchUp.memory.write, removeMemory: catchUp.memory.remove }}
      reflect={catchUp.reflection}
      listModels={catchUp.listModels}
      onShowDesks={onShowDesks}
      onShowBoard={onShowBoard}
    />
  );
}

/** Settings: the harness and mod facts come from the two models; the chat preferences from useChatLayout. */
export function SettingsView({ desk, catchUp, boot, onInstallLetta, onCheckLetta, onUpdateLetta, chatWidth, onChatWidth, chatPlacement, onChatPlacement, onModelsChanged, update, shortcut, recall }: { update: LokiUpdate; shortcut: GlobalShortcut; recall: RecallModel; desk: Desk; catchUp: CatchUp; boot: BootstrapStatus | null; onInstallLetta: () => Promise<void>; onCheckLetta: () => Promise<string | null>; onUpdateLetta: () => Promise<string | null>; chatWidth: ChatWidth; onChatWidth: (w: ChatWidth) => void; chatPlacement: ChatPlacement; onChatPlacement: (p: ChatPlacement) => void; onModelsChanged: () => void }) {
  const { attention } = desk;
  return <Settings appServerStatus={attention.available ? (catchUp.status === "off" ? "connecting" : catchUp.status) : "unavailable"} tunnelUrl={attention.tunnelUrl} modConnection={desk.connection} deskCount={desk.desks.list.filter((d) => d.status === "live").length} chatWidth={chatWidth} onChatWidth={onChatWidth} chatPlacement={chatPlacement} onChatPlacement={onChatPlacement} lettaVersion={catchUp.server?.version ?? null} providers={catchUp.providers} onLoadProviders={catchUp.loadProviders} onConnectProvider={catchUp.connectProvider} onDisconnectProvider={catchUp.disconnectProvider} onModelsChanged={onModelsChanged} bootstrap={boot} onInstallLetta={onInstallLetta} onCheckLetta={onCheckLetta} onUpdateLetta={onUpdateLetta} phone={desk.phone} globalSkills={{ list: desk.agents.globalSkills, enable: catchUp.skills.enable, disable: catchUp.skills.disable }} update={update} shortcut={shortcut} recall={recall} />;
}

/** First launch, over the empty desk: the provider, the first agent, its desk. */
export function WelcomeView({ step, catchUp, boot, onInstallLetta, models, onLoadModels, onModelsChanged, onDone }: { step: "letta" | "provider" | "agent"; catchUp: CatchUp; boot: BootstrapStatus | null; onInstallLetta: () => Promise<void>; models: ModelEntry[] | null; onLoadModels: () => void; onModelsChanged: () => void; onDone: (agentId: string) => void }) {
  return (
    <Welcome
      step={step}
      providers={catchUp.providers}
      onLoadProviders={catchUp.loadProviders}
      onConnect={catchUp.connectProvider}
      onDisconnect={catchUp.disconnectProvider}
      onModelsChanged={onModelsChanged}
      models={models ? models.map((m) => m.handle) : null}
      onLoadModels={onLoadModels}
      onCreate={catchUp.createAgent}
      bootstrap={boot}
      onInstallLetta={onInstallLetta}
      onDone={onDone}
    />
  );
}

/** ⏎ / ⌘⏎ on the board: which tasks, and whether to dispatch. Consumed by the picker (or a new desk). */
export type Picker = { ids: string[]; start: boolean };

/** The board's target picker: the same tree, choosing instead of switching. A new desk carries the tasks along through `pendingAssignRef` (named as a ref so the compiler accepts the write in the handler). */
export function PickerTree({ picker, onClose, desk, catchUp, onAssign, pendingAssignRef, onNewDesk }: { picker: Picker | null; onClose: () => void; desk: Desk; catchUp: CatchUp; onAssign: (target: AssignTarget, ids: string[], start: boolean) => Promise<void>; pendingAssignRef: MutableRefObject<Picker | null>; onNewDesk: (agentId: string | null, name: string) => void }) {
  return (
    <DeskTree
      open={!!picker}
      onClose={onClose}
      heading={picker ? `${picker.start ? "dispatch" : "assign"} ${picker.ids.length === 1 ? "1 task" : `${picker.ids.length} tasks`} to…${picker.start ? " (the agent starts now)" : ""}` : null}
      desks={desk.desks.list}
      agents={catchUp.agents}
      items={catchUp.items}
      current={desk.scope}
      onSwitch={() => {}}
      onPickDesk={(d) => {
        const p = picker;
        onClose();
        if (p) void onAssign({ scope: d.scope, agentId: d.agentId, agentName: d.agentName, conversationId: d.conversationId, title: d.title }, p.ids, p.start);
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

/** ⌘K: the desks tree as the quick switcher, with pin and archive on each row. */
export function SwitcherTree({ open, onClose, desk, catchUp, visited, onSwitch, onSwitchChat, onNewDesk, notice }: { open: boolean; onClose: () => void; desk: Desk; catchUp: CatchUp; visited: string[]; onSwitch: (scope: string) => void; onSwitchChat: (scope: string) => void; onNewDesk: (agentId: string | null, name: string) => void; notice: (m: string) => void }) {
  return (
    <DeskTree
      open={open}
      onClose={onClose}
      desks={desk.desks.list}
      agents={catchUp.agents}
      items={catchUp.items}
      current={desk.scope}
      onSwitch={onSwitch}
      onSwitchChat={onSwitchChat}
      visited={visited}
      onNew={desk.attention.available ? onNewDesk : undefined}
      onPin={(d, pinned) => {
        if (d.agentId && d.conversationId) desk.desks.pin(d.agentId, d.conversationId, pinned);
      }}
      onArchive={
        desk.attention.available
          ? (d, archived) => {
              if (!d.conversationId) return;
              void catchUp.archiveConversation(d.conversationId, archived).then((err) => {
                if (err) return notice(`archive: ${err}`);
                notice(`${d.title ?? d.scope} ${archived ? "archived" : "restored"}`);
                desk.desks.request();
              });
            }
          : undefined
      }
    />
  );
}

/** The new-desk dialog; `defaultFolder` stays null whether or not the desk has a runtime. */
export function NewDeskSheet({ state, onClose, desk, catchUp, onCreate }: { state: { open: boolean; name: string; agentId: string | null }; onClose: () => void; desk: Desk; catchUp: CatchUp; onCreate: (agent: string, folder: string, name: string) => Promise<void> }) {
  const deskRuntime = desk.agentId && desk.conversationId ? { agent_id: desk.agentId, conversation_id: desk.conversationId } : null;
  return <NewDesk open={state.open} onClose={onClose} agents={catchUp.agents} defaultAgentId={state.agentId ?? desk.agentId} defaultFolder={deskRuntime ? null : null} initialName={state.name} folders={desk.attention.folders} onCreate={onCreate} />;
}
