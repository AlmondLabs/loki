import { useMemo } from "react";
import type { AdvisorView } from "../../../core/advisor.ts";
import { harnessOf, type ModelEntry, type ModelSelection, type ReasoningEffort } from "../../../core/models.ts";
import { scopeFor } from "../../../core/desk-core.ts";
import type { TranscriptRow } from "../../../core/attention/transcript.ts";
import { useThreadRows, type useAttention } from "../../../core/attention/use-attention.ts";
import { draftKey, useDraft } from "../shared/drafts";
import { Conversation, type ConversationActions, type ConversationView } from "../chat/conversation";
import { avatarUrl } from "./env";
import { useDeskChat, type DeskChatModel } from "./use-desk-chat";

interface Rt {
  agent_id: string;
  conversation_id: string;
}

export interface AdvisorModels {
  entries: ModelEntry[] | null;
  model: string | null;
  reasoningEffort: ReasoningEffort | null;
  onLoad?: () => void;
  onPick?: (scope: string, rt: Rt, selection: ModelSelection) => Promise<void>;
}

export const lokiModels = (entries: ModelEntry[] | null): ModelEntry[] | null => entries?.filter((e) => harnessOf(e.handle) === null) ?? null;

export function advisorConversation(
  catchUp: Pick<ReturnType<typeof useAttention>, "send" | "answer" | "decide" | "cancelQueued" | "stop">,
  chat: Pick<DeskChatModel, "deskRuntime" | "deskChat">,
  advisor: AdvisorView | null | undefined,
  models: AdvisorModels,
  rows: TranscriptRow[] | undefined,
): { view: ConversationView; actions: ConversationActions } {
  const { deskRuntime: rt, deskChat: face } = chat;
  const view: ConversationView = {
    rows,
    status: face?.status ?? "idle",
    error: face?.error ?? null,
    model: models.model ?? advisor?.model ?? null,
    reasoningEffort: models.reasoningEffort,
    engine: face?.engine ?? null,
    approval: face?.pending ?? null,
    question: face?.question ?? null,
    older: face?.older ?? null,
    loadFailed: face?.loadFailed ?? null,
    loadStep: face?.loadStep,
  };
  const { onPick } = models;
  const actions: ConversationActions = {
    onSend: (text, images) => rt && catchUp.send(rt, text, images, { desk: null, labels: null, origin: "desk" }),
    onAnswer: (answers) => {
      if (rt && face?.question) catchUp.answer(rt, face.question.requestId, answers);
    },
    onApprove: (behavior) => {
      if (rt && face?.pending) catchUp.decide(rt, face.pending.requestId, behavior);
    },
    onCancelQueued: (text) => rt && catchUp.cancelQueued(rt, text),
    onStop: rt ? () => catchUp.stop(rt) : undefined,
    onLoadModels: models.onLoad,
    onPickModel: rt && onPick ? (selection) => onPick(scopeFor(rt.conversation_id, rt.agent_id), rt, selection) : undefined,
  };
  return { view, actions };
}

export function AdvisorPanel({
  catchUp,
  agentId,
  agentName,
  advisorChat,
  advisor,
  models,
  focusTick,
  findTick,
  modelPickerTick,
}: {
  catchUp: ReturnType<typeof useAttention>;
  agentId: string;
  agentName: string | null;
  advisorChat: string;
  advisor: AdvisorView | null | undefined;
  models: AdvisorModels;
  focusTick: number;
  findTick: number;
  modelPickerTick: number;
}) {
  const chat = useDeskChat({ agentId, conversationId: advisorChat, showing: true, catchUp });
  const rows = useThreadRows(catchUp, agentId, advisorChat);
  const [draftValue, setDraft] = useDraft(draftKey(agentId, advisorChat));
  const people = useMemo(
    () => ({ assistant: { name: agentName ? `${agentName}'s advisor` : "Advisor", avatar: avatarUrl(agentId) }, user: { name: "You" } }),
    [agentName, agentId],
  );
  const offered = useMemo(() => lokiModels(models.entries), [models.entries]);
  const { view, actions } = advisorConversation(catchUp, chat, advisor, models, rows);
  return (
    <Conversation
      view={view}
      actions={actions}
      models={offered}
      focusTick={focusTick}
      findTick={findTick}
      modelPickerTick={modelPickerTick}
      agentName={agentName}
      layout={{ people }}
      draft={{ value: draftValue, onChange: setDraft }}
      dim={false}
    />
  );
}
