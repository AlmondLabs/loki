import { useEffect, useEffectEvent } from "react";
import type { useAttention } from "../../../core/attention/use-attention.ts";

export function useDeskChat({
  agentId,
  conversationId,
  showing,
  catchUp,
}: {
  agentId: string | null;
  conversationId: string | null;
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

export type DeskChatModel = ReturnType<typeof useDeskChat>;
