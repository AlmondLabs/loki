import { useMemo } from "react";
import { CheckIcon, CircleAlertIcon, LoaderCircleIcon, LockIcon, SquareIcon } from "lucide-react";
import type { ChatEvent } from "../../../core/attention/model.ts";
import type { TranscriptRow } from "../../../core/attention/transcript.ts";
import { useThreadRows, type useAttention } from "../../../core/attention/use-attention.ts";
import { scopeFor } from "../../../core/chat-scope.ts";
import type { ModelSelection, ReasoningEffort } from "../../../core/models.ts";
import { subagentDisplayName, type SubagentStatus, type SubagentView } from "../../../core/subagents.ts";
import { Conversation, type ConversationActions, type ConversationView } from "../chat/conversation";
import type { ModelEntry } from "../chat/model-picker";
import { draftKey, useDraft } from "../shared/drafts";
import { avatarUrl } from "./env";
import type { useWorkspace } from "./use-workspace";
import { useWorkspaceChat, type DeskChatModel } from "./use-workspace-chat";

export interface WorkerModels {
  entries: ModelEntry[] | null;
  model: string | null;
  reasoningEffort: ReasoningEffort | null;
  onLoad?: () => void;
  onPick?: (scope: string, rt: { agent_id: string; conversation_id: string }, selection: ModelSelection) => Promise<void>;
}

export const lokiModels = (entries: ModelEntry[] | null | undefined): ModelEntry[] | null =>
  entries ? entries.filter((m) => !m.handle.startsWith("acp:")) : null;

const shortModel = (model: string | null): string | null => {
  if (!model) return null;
  const slash = model.indexOf("/");
  return slash >= 0 ? model.slice(slash + 1) : model;
};

export function workerConversation(
  catchUp: Pick<ReturnType<typeof useAttention>, "status" | "send" | "answer" | "decide" | "commands" | "execute" | "cancelQueued" | "stop">,
  chat: DeskChatModel,
  worker: SubagentView,
  models: WorkerModels,
  rows: TranscriptRow[] | undefined,
): { view: ConversationView; actions: ConversationActions } {
  const { deskRuntime, deskChat, pendingApproval, pendingQuestion } = chat;
  const view: ConversationView = {
    rows,
    status: deskChat?.status ?? (worker.status === "running" ? "thinking" : "idle"),
    error: catchUp.status === "off" || catchUp.status === "closed" ? "chat needs loki's daemon — is it running?" : (deskChat?.error ?? worker.error ?? null),
    model: models.model ?? worker.model ?? null,
    reasoningEffort: models.reasoningEffort,
    engine: deskChat?.engine ?? null,
    approval: pendingApproval,
    question: pendingQuestion,
    older: deskChat?.older ?? null,
    loadFailed: deskChat?.loadFailed ?? null,
    loadStep: deskChat?.loadStep,
  };
  const actions: ConversationActions = {
    onSend: (text, images) => deskRuntime && catchUp.send(deskRuntime, text, images),
    onAnswer: (answers) => {
      if (deskRuntime && pendingQuestion) catchUp.answer(deskRuntime, pendingQuestion.requestId, answers);
    },
    onApprove: (behavior) => {
      if (deskRuntime && pendingApproval) catchUp.decide(deskRuntime, pendingApproval.requestId, behavior);
    },
    commands: catchUp.commands.filter((c) => c.id === "compact" || c.id === "stop"),
    onCommand: (id, args) => {
      if (deskRuntime) void catchUp.execute(deskRuntime, id, args);
    },
    onLoadModels: models.onLoad,
    onPickModel: (() => {
      const { onPick } = models;
      return deskRuntime && onPick ? (selection) => onPick(scopeFor(worker.chat_id, deskRuntime.agent_id), deskRuntime, selection) : undefined;
    })(),
    onCancelQueued: (text) => deskRuntime && catchUp.cancelQueued(deskRuntime, text),
    onStop: deskRuntime ? () => catchUp.stop(deskRuntime) : undefined,
  };
  return { view, actions };
}

function StatusGlyph({ status }: { status: SubagentStatus }) {
  if (status === "running") return <LoaderCircleIcon size={12} className="loki-worker-status animate-spin" aria-hidden />;
  if (status === "error") return <CircleAlertIcon size={12} className="loki-worker-status" aria-hidden />;
  if (status === "stopped") return <SquareIcon size={12} className="loki-worker-status" aria-hidden />;
  return <CheckIcon size={12} className="loki-worker-status" aria-hidden />;
}

export function WorkersPanel({
  catchUp,
  agentId,
  agentName,
  subagents,
  selectedChat,
  onSelectChat,
  desk,
  models,
  focusTick = 0,
  findTick = 0,
  modelPickerTick = 0,
}: {
  catchUp: ReturnType<typeof useAttention>;
  agentId: string;
  agentName: string | null;
  subagents: readonly SubagentView[];
  selectedChat: string | null;
  onSelectChat: (chatId: string) => void;
  desk: Pick<ReturnType<typeof useWorkspace>, "modelOf" | "reasoningEffortOf">;
  models: Omit<WorkerModels, "model" | "reasoningEffort">;
  focusTick?: number;
  findTick?: number;
  modelPickerTick?: number;
}) {
  const active =
    (selectedChat ? subagents.find((s) => s.chat_id === selectedChat) : undefined) ?? subagents.find((s) => s.status === "running") ?? subagents.at(0);
  if (!active) return null;
  const workerScope = scopeFor(active.chat_id, agentId);
  return (
    <div className="loki-workers-pane">
      <div className="loki-workers-bar" role="group" aria-label="Workers">
        {subagents.map((s) => {
          const selected = s.chat_id === active.chat_id;
          const label = s.name || subagentDisplayName(s.id);
          const modelLabel = shortModel(s.model);
          return (
            <button
              key={s.chat_id}
              type="button"
              className="loki-worker-pill"
              data-status={s.status}
              aria-pressed={selected}
              title={s.description}
              onClick={() => onSelectChat(s.chat_id)}
            >
              <StatusGlyph status={s.status} />
              <span>{label}</span>
              {modelLabel && <span className="loki-worker-pill-meta">{modelLabel}</span>}
              {s.read_only && <LockIcon size={10} aria-label="Read-only" />}
            </button>
          );
        })}
      </div>
      <div className="loki-worker-meta">
        <span className="truncate">{active.description}</span>
        {active.read_only && <span>· Read-only</span>}
        {active.branch && <span>· {active.branch}</span>}
      </div>
      <div className="loki-workers-thread">
        <WorkerThread
          key={active.chat_id}
          catchUp={catchUp}
          agentId={agentId}
          agentName={agentName}
          worker={active}
          models={{
            ...models,
            model: desk.modelOf(workerScope),
            reasoningEffort: desk.reasoningEffortOf(workerScope),
          }}
          focusTick={focusTick}
          findTick={findTick}
          modelPickerTick={modelPickerTick}
        />
      </div>
    </div>
  );
}

function WorkerThread({
  catchUp,
  agentId,
  agentName,
  worker,
  models,
  focusTick,
  findTick,
  modelPickerTick,
}: {
  catchUp: ReturnType<typeof useAttention>;
  agentId: string;
  agentName: string | null;
  worker: SubagentView;
  models: WorkerModels;
  focusTick: number;
  findTick: number;
  modelPickerTick: number;
}) {
  const chat = useWorkspaceChat({ agentId, conversationId: worker.chat_id, showing: true, catchUp });
  const rows = useThreadRows(catchUp, agentId, worker.chat_id);
  const [draftValue, setDraft] = useDraft(draftKey(agentId, worker.chat_id));
  const workerName = worker.name || subagentDisplayName(worker.id);
  const people = useMemo(
    () => ({ assistant: { name: agentName ? `${workerName} · ${agentName}` : workerName, avatar: avatarUrl(agentId) }, user: { name: "You" } }),
    [agentId, agentName, workerName],
  );
  const workerModels = useMemo(() => lokiModels(models.entries), [models.entries]);
  const { view, actions } = workerConversation(catchUp, chat, worker, models, rows);
  return (
    <Conversation
      view={view}
      actions={actions}
      models={workerModels}
      agentName={workerName}
      layout={{ people }}
      draft={{ value: draftValue, onChange: setDraft }}
      focusTick={focusTick}
      findTick={findTick}
      modelPickerTick={modelPickerTick}
    />
  );
}

export type WorkerChatEvent = Extract<ChatEvent, { kind: "subagents" }>;
