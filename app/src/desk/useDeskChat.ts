import { useEffect } from "react";
import type { useAttention } from "../../../core/attention/useAttention.ts";

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
  const deskChat = deskRuntime ? catchUp.conversation(deskRuntime.agent_id, deskRuntime.conversation_id) : null;
  const pendingApproval = deskChat?.pending ?? null;
  const pendingQuestion = deskChat?.question ?? null;
  useEffect(() => {
    if (deskRuntime && catchUp.status === "open") void catchUp.subscribe(deskRuntime);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentId, conversationId, catchUp.status]);
  useEffect(() => {
    if (showing && deskRuntime && catchUp.status === "open") void catchUp.loadThread(deskRuntime);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showing, agentId, conversationId, catchUp.status]);

  return { deskRuntime, deskChat, pendingApproval, pendingQuestion };
}

export type DeskChatModel = ReturnType<typeof useDeskChat>;
