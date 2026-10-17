import type { ConversationActions, ConversationView } from "../chat/conversation";
import type { useAttention } from "../../../core/attention/use-attention.ts";
import { LOKI_COMMANDS } from "../../../core/attention/commands.ts";
import { labelCommand } from "../chat/labels";
import type { ModelSelection } from "../../../core/models.ts";
import { runAction } from "../shell/keymap";
import type { useDesk } from "./use-desk";
import type { DeskChatModel } from "./use-desk-chat";

interface Rt {
  agent_id: string;
  conversation_id: string;
}

/** What the shell does for a chat's conversation that the pane cannot: load the models, and switch the chat's model or permission mode through the daemon. */
export interface DeskConversationHandlers {
  onLoadModels?: () => void;
  /** Open the chat's labels… picker (`/label` with no name); left out, `/label` alone says to name one. */
  onOpenLabels?: () => void;
  /** Switch this desk's conversation to a model; the shell talks to the daemon. */
  onPickModel?: (scope: string, rt: Rt, selection: ModelSelection) => Promise<void>;
  /** Set this desk's conversation permission mode; the shell talks to the daemon. */
  onPickMode?: (scope: string, rt: Rt, mode: string) => Promise<void>;
}

/**
 * The desk's conversation as the shared Conversation takes it: what it looks like and what can be done to
 * it. One builder for both views of a desk (the Messages tab and the Desk tab's inset), so they never drift.
 */
export function deskConversation(
  desk: ReturnType<typeof useDesk>,
  catchUp: ReturnType<typeof useAttention>,
  chat: DeskChatModel,
  { onLoadModels, onPickModel, onPickMode, onOpenLabels }: DeskConversationHandlers,
): { view: ConversationView; actions: ConversationActions } {
  const { scope, title, attention } = desk;
  const { deskRuntime, deskChat, pendingApproval, pendingQuestion } = chat;
  const view: ConversationView = {
    rows: deskChat?.rows ?? [],
    status: deskChat?.status ?? "idle",
    error: !attention.available ? "chat needs loki's daemon — is it running?" : (deskChat?.error ?? null),
    model: desk.model,
    reasoningEffort: desk.reasoningEffort,
    mode: deskChat?.mode ?? desk.mode,
    engine: deskChat?.engine ?? null,
    approval: pendingApproval,
    question: pendingQuestion,
    older: deskChat?.older ?? null,
  };
  const actions: ConversationActions = {
    onSend: (text, images) =>
      deskRuntime &&
      catchUp.send(deskRuntime, text, images, { desk: title, labels: desk.desks.list.find((d) => d.scope === scope)?.labels ?? null, origin: "desk" }),
    onAnswer: (answers) => {
      if (deskRuntime && pendingQuestion) catchUp.answer(deskRuntime, pendingQuestion.requestId, answers);
    },
    onApprove: (behavior) => {
      if (deskRuntime && pendingApproval) catchUp.decide(deskRuntime, pendingApproval.requestId, behavior);
    },
    commands: catchUp.commands,
    onCommand: (id, args) => {
      // loki's own commands are keymap actions; everything else is the daemon's, run for this conversation.
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
  };
  return { view, actions };
}

/** A chat's labels saved through loki's daemon, then the desks list asked for again so every chip shows them. */
export async function saveLabels(desk: ReturnType<typeof useDesk>, catchUp: ReturnType<typeof useAttention>, rt: Rt, labels: string[]): Promise<string | null> {
  const err = await catchUp.labels.set(rt, labels);
  if (!err) desk.desks.request();
  return err;
}
