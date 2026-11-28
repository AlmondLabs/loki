import { useEffect, useMemo, useRef, type KeyboardEvent } from "react";
import { CheckIcon, ChevronLeftIcon, ChevronRightIcon, CircleAlertIcon, LoaderCircleIcon, LockIcon, SquareIcon } from "lucide-react";
import type { ChatEvent } from "../../../core/attention/model.ts";
import type { TranscriptRow } from "../../../core/attention/transcript.ts";
import { useThreadRows, type useAttention } from "../../../core/attention/use-attention.ts";
import { scopeFor } from "../../../core/chat-scope.ts";
import type { ModelSelection, ReasoningEffort } from "../../../core/models.ts";
import { subagentDisplayName, type SubagentStatus, type SubagentView } from "../../../core/subagents.ts";
import { Conversation, type ConversationActions, type ConversationView } from "../chat/conversation";
import type { ModelEntry } from "../chat/model-picker";
import { draftKey, useDraft } from "../shared/drafts";
import { keyFor } from "../shell/keymap";
import { avatarUrl } from "./env";
import { activeWorkerChat, stepWorkerChat } from "./pane";
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
  const activeChat = activeWorkerChat(subagents, selectedChat);
  const activeIndex = activeChat ? subagents.findIndex((s) => s.chat_id === activeChat) : -1;
  const active = activeIndex >= 0 ? subagents[activeIndex] : undefined;
  const pillsRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const selectedEl = pillsRef.current?.querySelector<HTMLElement>('button[aria-pressed="true"]');
    if (selectedEl && typeof selectedEl.scrollIntoView === "function") selectedEl.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [active?.chat_id]);
  if (!active) return null;
  const workerScope = scopeFor(active.chat_id, agentId);
  const step = (delta: -1 | 1) => {
    const next = stepWorkerChat(subagents, active.chat_id, delta);
    if (next) onSelectChat(next);
  };
  const onPillsKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (subagents.length < 2) return;
    let nextIndex: number | null = null;
    if (e.key === "ArrowLeft") nextIndex = (activeIndex - 1 + subagents.length) % subagents.length;
    else if (e.key === "ArrowRight") nextIndex = (activeIndex + 1) % subagents.length;
    else if (e.key === "Home") nextIndex = 0;
    else if (e.key === "End") nextIndex = subagents.length - 1;
    if (nextIndex === null) return;
    e.preventDefault();
    onSelectChat(subagents[nextIndex].chat_id);
    pillsRef.current?.querySelectorAll<HTMLButtonElement>(".loki-worker-pill")[nextIndex]?.focus();
  };
  return (
    <div className="loki-workers-pane">
      <div className="loki-workers-bar">
        <div ref={pillsRef} className="loki-workers-pills" role="group" aria-label="Workers" onKeyDown={onPillsKeyDown}>
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
        {subagents.length > 1 && (
          <div className="loki-workers-nav">
            <span className="loki-workers-count" aria-live="polite">
              {activeIndex + 1} / {subagents.length}
            </span>
            <button
              type="button"
              className="loki-worker-step"
              aria-label="Previous Worker"
              title={`Previous Worker (${keyFor("worker.prev")})`}
              onClick={() => step(-1)}
            >
              <ChevronLeftIcon size={14} aria-hidden />
            </button>
            <button
              type="button"
              className="loki-worker-step"
              aria-label="Next Worker"
              title={`Next Worker (${keyFor("worker.next")})`}
              onClick={() => step(1)}
            >
              <ChevronRightIcon size={14} aria-hidden />
            </button>
          </div>
        )}
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
