import type { ConversationActions, ConversationView } from "../chat/conversation";
import type { useAttention } from "../../../core/attention/use-attention.ts";
import { LOKI_COMMANDS } from "../../../core/attention/commands.ts";
import { labelCommand } from "../chat/labels";
import type { ModelSelection } from "../../../core/models.ts";
import type { TranscriptRow } from "../../../core/attention/transcript.ts";
import { runAction } from "../shell/keymap";
import { linksSeenFrom } from "../../../core/chat-links.ts";
import type { useWorkspace } from "./use-workspace";
import type { DeskChatModel } from "./use-workspace-chat";

interface Rt {
  agent_id: string;
  conversation_id: string;
}

export interface DeskConversationHandlers {
  onLoadModels?: () => void;
  onOpenLabels?: () => void;
  onPickModel?: (scope: string, rt: Rt, selection: ModelSelection) => Promise<void>;
  onPickMode?: (scope: string, rt: Rt, mode: string) => Promise<void>;
}

export function deskConversation(
  desk: ReturnType<typeof useWorkspace>,
  catchUp: ReturnType<typeof useAttention>,
  chat: DeskChatModel,
  { onLoadModels, onPickModel, onPickMode, onOpenLabels }: DeskConversationHandlers,
  rows: TranscriptRow[] | undefined,
): { view: ConversationView; actions: ConversationActions } {
  const { scope, title, attention } = desk;
  const { deskRuntime, deskChat, pendingApproval, pendingQuestion } = chat;
  const row = desk.desks.list.find((d) => d.scope === scope);
  const view: ConversationView = {
    rows,
    status: deskChat?.status ?? "idle",
    error: !attention.available ? "chat needs loki's daemon — is it running?" : (deskChat?.error ?? null),
    model: desk.model,
    reasoningEffort: desk.reasoningEffort,
    mode: deskChat?.mode ?? desk.mode,
    engine: deskChat?.engine ?? null,
    approval: pendingApproval,
    question: pendingQuestion,
    older: deskChat?.older ?? null,
    loadFailed: deskChat?.loadFailed ?? null,
    loadStep: deskChat?.loadStep,
    home: row?.home ? (row.home_name ?? "another Mac") : null,
    links: deskRuntime && deskChat ? linksSeenFrom(deskChat.links, deskRuntime) : undefined,
    subagents: deskChat?.subagents ?? [],
  };
  const actions: ConversationActions = {
    onSend: (text, images) =>
      deskRuntime &&
      catchUp.send(deskRuntime, text, images, { desk: title, labels: desk.desks.list.find((d) => d.scope === scope)?.labels ?? null, origin: "chats" }),
    onAnswer: (answers) => {
      if (deskRuntime && pendingQuestion) catchUp.answer(deskRuntime, pendingQuestion.requestId, answers);
    },
    onApprove: (behavior) => {
      if (deskRuntime && pendingApproval) catchUp.decide(deskRuntime, pendingApproval.requestId, behavior);
    },
    commands: catchUp.commands,
    onCommand: (id, args) => {
      const local = LOKI_COMMANDS.find((c) => c.id === id);
      if (id === "label" && deskRuntime) {
        const current = desk.desks.list.find((d) => d.scope === scope)?.labels ?? [];
        void labelCommand(args, current, (next) => saveLabels(desk, catchUp, deskRuntime, next), onOpenLabels);
      } else if (local?.action) runAction(local.action);
      else if (deskRuntime) void catchUp.execute(deskRuntime, id, args);
    },
    onLoadModels,
    onPickModel: deskRuntime && onPickModel ? (selection) => onPickModel(scope, deskRuntime, selection) : undefined,
    onPickMode: deskRuntime && onPickMode ? (m) => onPickMode(scope, deskRuntime, m) : undefined,
    onCancelQueued: (text) => deskRuntime && catchUp.cancelQueued(deskRuntime, text),
    onStop: deskRuntime ? () => catchUp.stop(deskRuntime) : undefined,
    onCloseLink: deskRuntime ? (linkId) => catchUp.links.close(deskRuntime, linkId) : undefined,
    onKeepHere: deskRuntime ? () => catchUp.keepMoveHere(deskRuntime) : undefined,
  };
  return { view, actions };
}

export async function saveLabels(
  desk: ReturnType<typeof useWorkspace>,
  catchUp: ReturnType<typeof useAttention>,
  rt: Rt,
  labels: string[],
): Promise<string | null> {
  const err = await catchUp.labels.set(rt, labels);
  if (!err) desk.desks.request();
  return err;
}
