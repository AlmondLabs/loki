import type { WidgetLogEntry } from "../../core/desk-core.ts";
import type { TranscriptRow } from "../../core/attention/transcript.ts";
import type { InboxRow } from "../../core/frame-types.ts";
import { HISTORY_MAX, HISTORY_PAGE } from "../desks.ts";
import { reply, type FrameHandlers } from "./context.ts";

export interface HistoryDeps {
  /** The last `limit` rows of a chat's log, and whether there are older ones (it survives compaction). */
  transcript?: (agentId: string | null, conversationId: string, limit: number) => { rows: TranscriptRow[]; more: boolean };
  /** That conversation's desk's widget change log (mod/widget-log.ts), served with its history. */
  widgetLog?: (agentId: string | null, conversationId: string) => WidgetLogEntry[];
  /** Every open conversation of the user's own agents, with its digest, for the Inbox (mod/desks.ts). */
  listInbox?: () => InboxRow[];
}

/** A chat's history from its local log, and the Inbox's list of open conversations. */
export function historyFrames(deps: HistoryDeps): FrameHandlers {
  return {
    history_get: ({ agentId, conversationId, limit }) => {
      // `limit` grows as the reader scrolls past the oldest row they have (HISTORY_PAGE at a time).
      const rows = Math.min(HISTORY_MAX, Math.max(HISTORY_PAGE, Math.floor(Number(limit)) || HISTORY_PAGE));
      const page = deps.transcript?.(agentId, conversationId, rows) ?? { rows: [], more: false };
      return reply({ agentId, conversationId, messages: page.rows, more: page.more, widgetLog: deps.widgetLog?.(agentId, conversationId) ?? [] });
    },
    inbox_list: () => reply({ conversations: deps.listInbox?.() ?? [] }),
  };
}
