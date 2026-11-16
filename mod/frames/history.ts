import type { WidgetLogEntry } from "../../core/desk-core.ts";
import { leanPage, type TranscriptRow } from "../../core/attention/transcript.ts";
import type { InboxRow } from "../../core/frame-types.ts";
import { HISTORY_MAX, HISTORY_PAGE } from "../desks.ts";
import { reply, type FrameHandlers } from "./context.ts";

export interface HistoryDeps {
  transcript?: (
    agentId: string | null,
    conversationId: string,
    limit: number,
    before: number | null,
  ) => { rows: TranscriptRow[]; more: boolean; start: number };
  row?: (agentId: string | null, conversationId: string, row: number) => TranscriptRow | null;
  widgetLog?: (agentId: string | null, conversationId: string) => WidgetLogEntry[];
  listInbox?: () => InboxRow[];
}

export function historyFrames(deps: HistoryDeps): FrameHandlers {
  return {
    history_get: ({ agent_id: agentId, conversation_id: conversationId, limit, before }) => {
      const rows = Math.min(HISTORY_MAX, Math.max(HISTORY_PAGE, Math.floor(Number(limit)) || HISTORY_PAGE));
      const page = deps.transcript?.(agentId, conversationId, rows, before) ?? { rows: [], more: false, start: 0 };
      return reply({
        agent_id: agentId,
        conversation_id: conversationId,
        messages: leanPage(page.rows, page.start),
        more: page.more,
        start: page.start,
        widget_log: deps.widgetLog?.(agentId, conversationId) ?? [],
      });
    },
    history_step_get: ({ agent_id: agentId, conversation_id: conversationId, row }) => {
      const whole = deps.row?.(agentId, conversationId, row);
      return reply({ step: whole?.role === "tool" ? (whole.tool ?? null) : null, detail: whole?.role === "event" ? (whole.detail ?? null) : null });
    },
    inbox_list: () => reply({ conversations: deps.listInbox?.() ?? [] }),
  };
}
