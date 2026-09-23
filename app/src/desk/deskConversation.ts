import type { ConversationActions, ConversationView } from "../chat/Conversation";
import type { useAttention } from "../../../core/attention/useAttention.ts";
import { LOKI_COMMANDS } from "../../../core/attention/commands.ts";
import type { ModelSelection } from "../../../core/models.ts";
import { runAction } from "../shell/keymap";
import type { useDesk } from "./useDesk";
import type { DeskChatModel } from "./useDeskChat";

type Rt = { agent_id: string; conversation_id: string };

export interface DeskConversationHandlers {
  onLoadModels?: () => void;
  /** Switch this desk's conversation to a model; the shell talks to the app-server. */
  onPickModel?: (scope: string, rt: Rt, selection: ModelSelection) => Promise<void>;
  /** Set this desk's conversation permission mode; the shell talks to the app-server. */
  onPickMode?: (scope: string, rt: Rt, mode: string) => Promise<void>;
}

/**
 * The desk's conversation as the shared Conversation takes it: what it looks like and what can be done to
 * it. One builder for both views of a desk (the Messages tab and the Desk tab's inset), so they never drift.
 */
export function deskConversation(desk: ReturnType<typeof useDesk>, catchUp: ReturnType<typeof useAttention>, chat: DeskChatModel, { onLoadModels, onPickModel, onPickMode }: DeskConversationHandlers): { view: ConversationView; actions: ConversationActions } {
  const { scope, title, attention } = desk;
  const { deskRuntime, deskChat, pendingApproval, pendingQuestion, deskFolder } = chat;
  const view: ConversationView = {
    rows: deskChat?.rows ?? [],
    status: deskChat?.status ?? "idle",
    error: !attention.available ? "chat needs Letta's app-server — is a harness running?" : deskChat?.error ?? null,
    model: desk.model,
    reasoningEffort: desk.reasoningEffort,
    mode: deskChat?.mode ?? desk.mode,
    approval: pendingApproval,
    question: pendingQuestion,
  };
  const actions: ConversationActions = {
    onSend: (text, images) => deskRuntime && catchUp.send(deskRuntime, text, images, { folder: deskFolder.current, desk: title, origin: "desk" }),
    onAnswer: (answers) => {
      if (deskRuntime && pendingQuestion) catchUp.answer(deskRuntime, pendingQuestion.requestId, answers);
    },
    onApprove: (behavior) => {
      if (deskRuntime && pendingApproval) catchUp.decide(deskRuntime, pendingApproval.requestId, behavior);
    },
    commands: catchUp.commands,
    onCommand: (id, args) => {
      // loki's own commands are keymap actions; everything else is the harness's, run for this conversation.
      const local = LOKI_COMMANDS.find((c) => c.id === id);
      if (local?.action) runAction(local.action);
      else if (deskRuntime) void catchUp.execute(deskRuntime, id, args);
    },
    onLoadModels,
    onPickModel: deskRuntime && onPickModel ? (selection) => onPickModel(scope, deskRuntime, selection) : undefined,
    onPickMode: deskRuntime && onPickMode ? (m) => onPickMode(scope, deskRuntime, m) : undefined,
    onCancelQueued: (text) => deskRuntime && catchUp.cancelQueued(deskRuntime, text),
  };
  return { view, actions };
}
