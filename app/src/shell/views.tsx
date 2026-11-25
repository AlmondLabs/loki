import { lazy, Suspense } from "react";
import { scopeFor } from "../../../core/desk-core.ts";
import { LOKI_COMMANDS } from "../../../core/attention/commands.ts";
import { labelCommand } from "../chat/labels";
import { saveLabels } from "../desk/desk-conversation";
import { runAction } from "./keymap";
import { SETTINGS_PAGE_KEY, type SettingsPage } from "../settings/pages";
import { SETTINGS_WINDOW, openSettingsWindow } from "./open-settings";
import { lastInput } from "../kit/motion";
import { FlowPlace } from "../desk/catch-up";
import type { PassSummaryHandler } from "../desk/use-flow-deck";
import type { FlowKind } from "../desk/flow-kinds";
import { Agents } from "../agents/agents";
import { Recall } from "../recall/recall";
import type { Recall as RecallModel } from "./use-recall";
import { avatarUrl } from "../desk/env";
import type { ModelEntry } from "../chat/model-picker";
import type { ChatPlacement, ChatWidth } from "../chat/chat-window";

import { Welcome } from "./welcome";
import type { DaemonStatus, WelcomeStep } from "./bootstrap";
import type { LokiUpdate } from "./use-loki-update";
import { chatWorking } from "./update-notice";
import type { GlobalShortcut } from "./use-global-shortcut";
import type { CatchUp, Desk, Runtime } from "./types";
import type { ModelSelection } from "../../../core/models.ts";
import type { SettingsProps } from "../settings/settings";

type OpenDesk = (agentId: string, conversationId: string, opts?: { chat?: boolean }) => void;
type PickModel = (scope: string, rt: Runtime, selection: ModelSelection) => Promise<void>;
type PickMode = (scope: string, rt: Runtime, mode: string) => Promise<void>;

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

const via = () => (lastInput() === "key" ? "key" : "click");

function openPreferencesOn(page: SettingsPage) {
  if (SETTINGS_WINDOW) return openSettingsWindow(page);
  try {
    sessionStorage.setItem(SETTINGS_PAGE_KEY, page);
  } catch {}
  runAction("segment.settings");
}

export function InboxView({
  desk,
  catchUp,
  models,
  onLoadModels,
  onPickModel,
  onPickMode,
  onOpenDesk,
  onOpenAdvisor,
  onClose,
  onPass,
  notice,
  kind,
  onKind,
}: {
  desk: Desk;
  catchUp: CatchUp;
  kind: FlowKind;
  onKind: (kind: FlowKind) => void;
  notice: (message: string) => void;
  models: ModelEntry[] | null;
  onLoadModels: () => void;
  onPickModel: PickModel;
  onPickMode: PickMode;
  onOpenDesk: OpenDesk;
  onOpenAdvisor: (agentId: string, conversationId: string) => void;
  onClose: () => void;
  onPass: PassSummaryHandler;
}) {
  return (
    <FlowPlace
      onClose={onClose}
      onPass={onPass}
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
      onOpenDesk={(agentId, conversationId) => {
        const item = catchUp.items.find((i) => i.agent_id === agentId && i.id === conversationId);
        if (item) catchUp.decided(item, "open", via());
        onOpenDesk(agentId, conversationId, { chat: true });
      }}
      onOpenAdvisor={onOpenAdvisor}
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

export function AgentsView({
  desk,
  catchUp,
  onOpenDesk,
  onAskToUpdate,
  onShowDesks,
}: {
  desk: Desk;
  catchUp: CatchUp;
  onOpenDesk: OpenDesk;
  onAskToUpdate: (agentId: string, text: string) => void;
  onShowDesks: () => void;
}) {
  return (
    <Agents
      agents={catchUp.agents}
      api={desk.agents}
      avatar={avatarUrl}
      desks={desk.desks.list}
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
      mcp={desk.calls.mcp}
      accounts={desk.calls.accounts}
      macs={desk.macs.view ? [desk.macs.view.me, ...desk.macs.view.peers] : undefined}
    />
  );
}

const Preferences = lazy(() => import("../settings/settings").then((m) => ({ default: m.Preferences })));

export interface PreferencesSources {
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
}

export function preferencesProps({
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
}: PreferencesSources): Omit<SettingsProps, "onClose" | "windowed"> {
  return {
    chatLink: catchUp.status === "off" ? "connecting" : catchUp.status,
    modConnection: desk.connection,
    deskCount: desk.desks.list.filter((d) => d.status === "live").length,
    chatWidth,
    onChatWidth,
    chatPlacement,
    onChatPlacement,
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
    recall,
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
