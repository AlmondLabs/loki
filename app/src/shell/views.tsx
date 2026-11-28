import { lazy, Suspense } from "react";
import { scopeFor } from "../../../core/chat-scope.ts";
import { LOKI_COMMANDS } from "../../../core/attention/commands.ts";
import { labelCommand } from "../chat/labels";
import { saveLabels } from "../workspace/workspace-conversation";
import { runAction } from "./keymap";
import { SETTINGS_PAGE_KEY, type SettingsPage } from "../settings/pages";
import { SETTINGS_WINDOW, openSettingsWindow } from "./open-settings";
import { lastInput } from "../kit/motion";
import type { FlowKind } from "../workspace/flow-kinds";
const FlowPlace = lazy(() => import("../workspace/catch-up").then((m) => ({ default: m.FlowPlace })));
const Agents = lazy(() => import("../agents/agents").then((m) => ({ default: m.Agents })));
const Goals = lazy(() => import("../goals/goals").then((m) => ({ default: m.Goals })));
const Learn = lazy(() => import("../learn/learn").then((m) => ({ default: m.Learn })));
import type { GoalsView } from "../goals/views";
import type { GoalsModel } from "./use-goals";
import type { Learn as LearnModel } from "./use-learn";
import { avatarUrl } from "../workspace/env";
import type { ModelEntry } from "../chat/model-picker";

import { Welcome } from "./welcome";
import type { DaemonStatus, WelcomeStep } from "./bootstrap";
import type { LokiUpdate } from "./use-loki-update";
import { chatWorking } from "./update-notice";
import type { GlobalShortcut } from "./use-global-shortcut";
import type { CatchUp, Runtime, Workspace } from "./types";
import type { ModelSelection } from "../../../core/models.ts";
import type { SettingsProps } from "../settings/settings";

type OpenChat = (agentId: string, conversationId: string, opts?: { chat?: boolean }) => void;
type PickModel = (scope: string, rt: Runtime, selection: ModelSelection) => Promise<void>;
type PickMode = (scope: string, rt: Runtime, mode: string) => Promise<void>;

export function GoalsPane({
  goals,
  view,
  onView,
  selectedId,
  onSelect,
  agents,
  editingNew,
  onCloseNew,
  onOpenNew,
  onOpenChat,
}: {
  goals: GoalsModel;
  view: GoalsView;
  onView: (view: GoalsView) => void;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  agents: ReadonlyArray<{ id: string; name: string }>;
  editingNew: boolean;
  onCloseNew: () => void;
  onOpenNew: () => void;
  onOpenChat: (agentId: string, conversationId: string, brief?: string | null) => void;
}) {
  return (
    <Suspense fallback={null}>
      <Goals
        goals={goals}
        view={view}
        onView={onView}
        selectedId={selectedId}
        onSelect={onSelect}
        agents={agents}
        editingNew={editingNew}
        onCloseNew={onCloseNew}
        onOpenNew={onOpenNew}
        onOpenChat={onOpenChat}
      />
    </Suspense>
  );
}

export function LearnPane({
  recall,
  active,
  onOpenChat,
  onBegin,
}: {
  recall: LearnModel;
  active: boolean;
  onOpenChat: OpenChat;
  onBegin: (agentId: string, conversationId: string, brief: string, title: string) => void;
}) {
  return (
    <Suspense fallback={null}>
      <Learn recall={recall} active={active} onOpenChat={(agentId, conversationId) => onOpenChat(agentId, conversationId, { chat: true })} onBegin={onBegin} />
    </Suspense>
  );
}

const via = () => (lastInput() === "key" ? "key" : "click");

function openPreferencesOn(page: SettingsPage) {
  if (SETTINGS_WINDOW) return openSettingsWindow(page);
  try {
    sessionStorage.setItem(SETTINGS_PAGE_KEY, page);
  } catch {}
  runAction("segment.settings");
}

export function FlowView({
  desk,
  catchUp,
  models,
  onLoadModels,
  onPickModel,
  onPickMode,
  onOpenChat,
  onOpenWorker,
  onClose,
  notice,
  kind,
  onKind,
}: {
  desk: Workspace;
  catchUp: CatchUp;
  kind: FlowKind;
  onKind: (kind: FlowKind) => void;
  notice: (message: string) => void;
  models: ModelEntry[] | null;
  onLoadModels: () => void;
  onPickModel: PickModel;
  onPickMode: PickMode;
  onOpenChat: OpenChat;
  onOpenWorker: (agentId: string, conversationId: string, workerChat?: string) => void;
  onClose: () => void;
}) {
  return (
    <Suspense fallback={null}>
      <FlowPlace
        onClose={onClose}
        items={catchUp.items}
        lane={catchUp.flow.lane}
        kind={kind}
        onKind={onKind}
        onLane={(lane) => catchUp.flow.setLaneId(lane?.id ?? "")}
        onSignIn={() => openPreferencesOn("accounts")}
        labelList={catchUp.labels.list}
        onRead={(item) => catchUp.read(item, via())}
        onLater={(item, until) => catchUp.later(item, via(), until)}
        laterAsks={catchUp.laterAsks}
        onArchive={(item) => catchUp.archive(item, via())}
        onLabel={(item, labelIds) => catchUp.label(item, labelIds, via())}
        labelsOf={catchUp.labelsOf}
        onUndo={catchUp.undo}
        onSeen={(item) => catchUp.seen(item)}
        onUnread={(item) => catchUp.unread(item)}
        onApprove={(item, requestId, behavior) => (
          catchUp.decided(item, behavior !== "deny" ? "approve" : "deny", via()),
          catchUp.approve(item, requestId, behavior)
        )}
        onAnswer={(item, requestId, answers) => (catchUp.decided(item, "answer", via()), catchUp.answer(item.runtime, requestId, answers))}
        onReply={(item, text, images) => (catchUp.decided(item, "reply", via()), catchUp.reply(item, text, images))}
        onStop={(item) => catchUp.stop(item.runtime)}
        onShown={catchUp.shown}
        onOpenChat={(agentId, conversationId) => {
          const item = catchUp.items.find((i) => i.agent_id === agentId && i.id === conversationId);
          if (item) catchUp.decided(item, "open", via());
          onOpenChat(agentId, conversationId, { chat: true });
        }}
        onOpenWorker={onOpenWorker}
        chats={catchUp}
        loadHistory={(item) => void catchUp.loadHistory(item)}
        modelFor={(agentId, conversationId) => desk.modelOf(scopeFor(conversationId, agentId))}
        reasoningEffortFor={(agentId, conversationId) => desk.reasoningEffortOf(scopeFor(conversationId, agentId))}
        models={models}
        onLoadModels={onLoadModels}
        onPickModel={(item, selection) => onPickModel(scopeFor(item.id, item.agent_id), item.runtime, selection)}
        modeFor={(agentId, conversationId) => desk.modeOf(scopeFor(conversationId, agentId))}
        onPickMode={(item, mode) => onPickMode(scopeFor(item.id, item.agent_id), item.runtime, mode)}
        commands={catchUp.commands}
        onCommand={(item, id, args) => {
          const local = LOKI_COMMANDS.find((c) => c.id === id);
          if (id === "label") {
            const current = desk.desks.list.find((d) => d.scope === scopeFor(item.id, item.agent_id))?.labels ?? [];
            void labelCommand(args, current, (next) => saveLabels(desk, catchUp, item.runtime, next)).then((err) => err && notice(`labels: ${err}`));
          } else if (local?.action) runAction(local.action);
          else void catchUp.execute(item.runtime, id, args);
        }}
      />
    </Suspense>
  );
}

export function AgentsView({
  desk,
  catchUp,
  models,
  onLoadModels,
  onNewChat,
  onOpenChat,
  onAskToUpdate,
  onOpenPreferences,
  onNotice,
}: {
  desk: Workspace;
  catchUp: CatchUp;
  models: ModelEntry[] | null;
  onLoadModels: () => void;
  onNewChat: (agentId: string) => void;
  onOpenChat: OpenChat;
  onAskToUpdate: (agentId: string, text: string) => void;
  onOpenPreferences: (page: SettingsPage) => void;
  onNotice: (message: string) => void;
}) {
  return (
    <Suspense fallback={null}>
      <Agents
        agents={catchUp.agents}
        api={desk.agents}
        avatar={avatarUrl}
        desks={desk.desks.list}
        initialAgentId={desk.agentId}
        onOpenChat={(agentId, conversationId) => onOpenChat(agentId, conversationId, { chat: true })}
        onNewChat={onNewChat}
        onAskToUpdate={onAskToUpdate}
        onUpdateAgent={catchUp.updateAgent}
        write={{
          createAgent: catchUp.createAgent,
          deleteAgent: catchUp.deleteAgent,
          writeMemory: desk.calls.memory.write,
          removeMemory: desk.calls.memory.remove,
          revertMemory: desk.calls.memory.revert,
        }}
        models={models}
        onLoadModels={onLoadModels}
        mcp={desk.calls.mcp}
        accounts={desk.calls.accounts}
        macs={desk.macs.view ? [desk.macs.view.me, ...desk.macs.view.peers] : undefined}
        onOpenPreferences={onOpenPreferences}
        onNotice={onNotice}
      />
    </Suspense>
  );
}

const Preferences = lazy(() => import("../settings/settings").then((m) => ({ default: m.Preferences })));

export interface PreferencesSources {
  update: LokiUpdate;
  shortcut: GlobalShortcut;
  goals?: GoalsModel;
  recall: LearnModel;
  desk: Workspace;
  catchUp: CatchUp;
  daemon: DaemonStatus | null;
  onModelsChanged: () => void;
}

export function preferencesProps({
  desk,
  catchUp,
  daemon,
  onModelsChanged,
  update,
  shortcut,
  goals,
  recall,
}: PreferencesSources): Omit<SettingsProps, "onClose" | "windowed"> {
  return {
    chatLink: catchUp.status === "off" ? "connecting" : catchUp.status,
    modConnection: desk.connection,
    deskCount: desk.desks.list.filter((d) => d.status === "live").length,
    providers: catchUp.providers,
    onLoadProviders: catchUp.loadProviders,
    onConnectProvider: catchUp.connectProvider,
    onDisconnectProvider: catchUp.disconnectProvider,
    onModelsChanged,
    daemon,
    phone: desk.phone,
    macs: desk.macs,
    globalSkills: { list: desk.agents.globalSkills, enable: desk.calls.skills.enable, disable: desk.calls.skills.disable },
    mcp: desk.calls.mcp,
    accounts: desk.calls.accounts,
    agents: catchUp.agents,
    engines: desk.calls.engines,
    links: catchUp.links,
    labels: {
      list: catchUp.labels.list,
      edit: async (change) => {
        const err = await catchUp.labels.edit(change);
        if (!err) desk.desks.request();
        return err;
      },
    },
    update,
    working: chatWorking(catchUp.items),
    shortcut,
    goals,
    recall,
    reflect: catchUp.reflection,
    usage: { ...desk.usage, agents: catchUp.agents },
    returnTimes: { times: desk.attention.returnTimes, set: desk.attention.setReturnTimes },
    lanes: { lanes: desk.attention.lanes, set: desk.attention.setLanes },
  };
}

export function SettingsView({ onClose, ...sources }: PreferencesSources & { onClose: () => void }) {
  return (
    <Suspense fallback={null}>
      <Preferences onClose={onClose} {...preferencesProps(sources)} />
    </Suspense>
  );
}

export function WelcomeView({
  step,
  catchUp,
  daemon,
  onRetryDaemon,
  onInstallTools,
  onInstallNode,
  models,
  onLoadModels,
  onModelsChanged,
  onDone,
}: {
  step: WelcomeStep;
  catchUp: CatchUp;
  daemon: DaemonStatus | null;
  onRetryDaemon: () => Promise<void>;
  onInstallTools: () => Promise<string | null>;
  onInstallNode: () => Promise<string | null>;
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
      onInstallTools={onInstallTools}
      onInstallNode={onInstallNode}
      onDone={onDone}
    />
  );
}
