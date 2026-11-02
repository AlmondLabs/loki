import { useMemo } from "react";
import { scopeFor } from "../../../core/desk-core.ts";
import type { AttentionItem } from "../../../core/attention/model.ts";
import { useInlineWidgets } from "../chat/use-inline-widgets";
import type { MessageLayout, TranscriptRow } from "../chat/transcript";
import { avatarUrl } from "../desk/env";
import { dayLabel, unreadBoundary } from "../shared/thread";

/**
 * What the phone's two threads (an Inbox card and a chat's page) share around the conversation: its people, the
 * unread line, the chat's widgets read only (the phone may not change a desk), and the notice and box words.
 */

/** The thread's layout: who speaks, where the New line goes and its day, and the widgets under the rows that made them. */
export function useThreadLayout(
  chat: { agentId: string; conversationId: string; agentName: string | null | undefined },
  rows: TranscriptRow[] | undefined,
  item: Pick<AttentionItem, "unread" | "seenAt" | "last_message_at"> | null,
  look: string | null | undefined,
): MessageLayout {
  const { agentId, conversationId, agentName } = chat;
  const people = useMemo(() => ({ assistant: { name: agentName ?? "agent", avatar: avatarUrl(agentId) }, user: { name: "You" } }), [agentName, agentId]);
  const dividerAt = unreadBoundary(rows, item?.unread ?? false, item?.seenAt, look);
  const { widgets, inline } = useInlineWidgets(undefined, scopeFor(conversationId, agentId), rows, agentName ?? null, { readOnly: true });
  return useMemo(
    () => ({ people, dividerAt, dividerDay: dayLabel(item?.last_message_at), widgets, inline }),
    [people, dividerAt, item?.last_message_at, widgets, inline],
  );
}

/** The pill over the box with what the agent is doing or wants; `status` makes a screen reader say it as it changes. */
export function ThreadNotice({ text, status = false }: { text: string; status?: boolean }) {
  return (
    <div className="loki-phone-notice" role={status ? "status" : undefined}>
      <span className="loki-phone-ellipsis">{text}</span>
    </div>
  );
}

/** The box's placeholder: what a reply does while a question or an approval is open, else whom it goes to. */
export const replyPlaceholder = (asked: boolean, deciding: boolean, agentName: string): string =>
  asked ? "Answer, or pick above" : deciding ? "Reply, or decide below" : `Message ${agentName}`;
