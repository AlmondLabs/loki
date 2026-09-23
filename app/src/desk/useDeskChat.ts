import { useEffect, useRef } from "react";
import { conversationDirName } from "../../../core/desk-core.ts";
import type { useDesk } from "./useDesk";
import type { useAttention } from "../../../core/attention/useAttention.ts";

/**
 * The desk's conversation, from the same model the inbox uses: subscribed while the desk is open,
 * transcript loaded whenever a view of it shows (the Messages tab, or the Desk tab's open inset), streaming rows and approvals shared with the deck. Also
 * keeps the conversation's working folder, sent along with each message; only the send handler reads it.
 */
export function useDeskChat({
  agentId,
  conversationId,
  connection,
  showing,
  catchUp,
  attention,
}: {
  agentId: string | null;
  conversationId: string | null;
  connection: ReturnType<typeof useDesk>["connection"];
  /** A view of the conversation is on screen: the desk pane, or the inset chat. */
  showing: boolean;
  catchUp: ReturnType<typeof useAttention>;
  attention: ReturnType<typeof useDesk>["attention"];
}) {
  const deskFolder = useRef<string | null>(null);
  const deskRuntime = agentId && conversationId ? { agent_id: agentId, conversation_id: conversationId } : null;
  const deskChat = deskRuntime ? catchUp.conversation(deskRuntime.agent_id, deskRuntime.conversation_id) : null;
  const pendingApproval = deskChat?.pending ?? null;
  const pendingQuestion = deskChat?.question ?? null;
  useEffect(() => {
    if (deskRuntime && catchUp.status === "open") void catchUp.subscribe(deskRuntime);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentId, conversationId, catchUp.status]);
  useEffect(() => {
    deskFolder.current = null;
    if (!deskRuntime) return;
    let stale = false; // an answer for the previous conversation must not land on this one
    void attention.folders.recent().then((r) => {
      if (!stale) deskFolder.current = r.byConversation[conversationDirName(deskRuntime.conversation_id, deskRuntime.agent_id)] ?? null;
    });
    return () => {
      stale = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentId, conversationId, connection]);
  useEffect(() => {
    if (showing && deskRuntime && catchUp.status === "open") void catchUp.loadThread(deskRuntime);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showing, agentId, conversationId, catchUp.status]);

  return { deskRuntime, deskChat, pendingApproval, pendingQuestion, deskFolder };
}

export type DeskChatModel = ReturnType<typeof useDeskChat>;
