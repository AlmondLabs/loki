import type { WidgetLogEntry } from "../../core/desk-core.ts";
import type { TranscriptRow } from "../../core/attention/transcript.ts";
import type { InboxRow } from "../../core/frame-types.ts";
import { HISTORY_MAX, HISTORY_PAGE } from "../desks.ts";
import { reply, type FrameHandlers } from "./context.ts";

/** What the history frame handler needs from its host; each part missing answers empty. */
export interface HistoryDeps {
  /**
   * Up to `limit` rows of a chat's log ending before position `before` (its newest when null), the position of the
   * first, and whether there are older ones (it survives compaction).
   */
  transcript?: (
    agentId: string | null,
    conversationId: string,
    limit: number,
    before: number | null,
  ) => { rows: TranscriptRow[]; more: boolean; start: number };
  /** That conversation's desk's widget change log (mod/widget-log.ts), served with its history. */
  widgetLog?: (agentId: string | null, conversationId: string) => WidgetLogEntry[];
  /** Every open conversation of the user's own agents, with its digest, for the Inbox (mod/desks.ts). */
  listInbox?: () => InboxRow[];
}

/** A chat's history from the daemon's projection of its store, and the Inbox's list of open conversations. */
export function historyFrames(deps: HistoryDeps): FrameHandlers {
  return {
    history_get: ({ agent_id: agentId, conversation_id: conversationId, limit, before }) => {
      // A reader pages back by `before`, the position of the oldest row it has (plan 033); an older one asked for a
      // `limit` that grew as it scrolled, which still answers with the newest rows.
      const rows = Math.min(HISTORY_MAX, Math.max(HISTORY_PAGE, Math.floor(Number(limit)) || HISTORY_PAGE));
      const page = deps.transcript?.(agentId, conversationId, rows, before) ?? { rows: [], more: false, start: 0 };
      return reply({
        agent_id: agentId,
        conversation_id: conversationId,
        messages: page.rows,
        more: page.more,
        start: page.start,
        widget_log: deps.widgetLog?.(agentId, conversationId) ?? [],
      });
    },
    inbox_list: () => reply({ conversations: deps.listInbox?.() ?? [] }),
  };
}
