import { useMemo } from "react";
import type { AttentionItem } from "../../../core/attention/model.ts";
import type { MessageLayout, TranscriptRow } from "../chat/transcript";
import { avatarUrl } from "../workspace/env";
import { dayLabel, unreadBoundary } from "../shared/thread";

export function useThreadLayout(
  chat: { agentId: string; conversationId: string; agentName: string | null | undefined },
  rows: TranscriptRow[] | undefined,
  item: Pick<AttentionItem, "unread" | "seenAt" | "last_message_at"> | null,
  look: string | null | undefined,
): MessageLayout {
  const { agentId, agentName } = chat;
  const people = useMemo(() => ({ assistant: { name: agentName ?? "agent", avatar: avatarUrl(agentId) }, user: { name: "You" } }), [agentName, agentId]);
  const dividerAt = unreadBoundary(rows, item?.unread ?? false, item?.seenAt, look);
  return useMemo(() => ({ people, dividerAt, dividerDay: dayLabel(item?.last_message_at) }), [people, dividerAt, item?.last_message_at]);
}

export function ThreadNotice({ text, status = false }: { text: string; status?: boolean }) {
  return (
    <div className="loki-phone-notice" role={status ? "status" : undefined}>
      <span className="loki-phone-ellipsis">{text}</span>
    </div>
  );
}

export const replyPlaceholder = (asked: boolean, deciding: boolean, agentName: string): string =>
  asked ? "Answer, or pick above" : deciding ? "Reply, or drag to decide" : `Message ${agentName}`;
