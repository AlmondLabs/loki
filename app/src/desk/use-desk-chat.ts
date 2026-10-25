import { useEffect, useEffectEvent } from "react";
import { useConversation, type useAttention } from "../../../core/attention/use-attention.ts";

/**
 * The desk's conversation, from the same model the inbox uses: subscribed while the desk is open,
 * transcript loaded whenever a view of it shows (the Messages tab, or the Desk tab's open inset), streaming rows and approvals shared with the deck.
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
  const deskChat = useConversation(catchUp, agentId, conversationId);
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
 * conversation in the Inbox's model, and any approval or question waiting.
 */
export type DeskChatModel = ReturnType<typeof useDeskChat>;
