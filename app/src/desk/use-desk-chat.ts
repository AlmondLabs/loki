import { useEffect, useEffectEvent } from "react";
import type { useAttention } from "../../../core/attention/use-attention.ts";

/**
 * The desk's conversation, from the same model the inbox uses: subscribed while the desk is open,
 * transcript loaded whenever a view of it shows (the Messages tab, or the Desk tab's open inset), approvals shared
 * with the deck. Everything but the rows: the views that draw the thread read those with useThreadRows, so a
 * streamed piece redraws the thread and not the pane around it (plan 032).
 */
export function useDeskChat({
  agentId,
  conversationId,
  showing,
  catchUp,
}: {
  agentId: string | null;
  conversationId: string | null;
  /** A view of the conversation is on screen: the desk pane, or the inset chat. */
  showing: boolean;
  catchUp: ReturnType<typeof useAttention>;
}) {
  const deskRuntime = agentId && conversationId ? { agent_id: agentId, conversation_id: conversationId } : null;
  const deskChat = deskRuntime ? catchUp.conversation(deskRuntime.agent_id, deskRuntime.conversation_id) : null;
  const pendingApproval = deskChat?.pending ?? null;
  const pendingQuestion = deskChat?.question ?? null;
  const subscribe = useEffectEvent(() => {
    if (deskRuntime && catchUp.status === "open") void catchUp.subscribe(deskRuntime);
  });
  const loadThread = useEffectEvent(() => {
    if (showing && deskRuntime && catchUp.status === "open") void catchUp.loadThread(deskRuntime);
  });
  useEffect(() => subscribe(), [agentId, conversationId, catchUp.status]);
  useEffect(() => loadThread(), [showing, agentId, conversationId, catchUp.status]);

  return { deskRuntime, deskChat, pendingApproval, pendingQuestion };
}

/**
 * A chat's conversation as `useDeskChat` returns it: its agent and conversation ids (null without both), its
 * conversation in the Inbox's model (without its rows), and any approval or question waiting.
 */
export type DeskChatModel = ReturnType<typeof useDeskChat>;
