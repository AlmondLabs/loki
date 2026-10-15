import type { AttentionItem } from "../../../core/attention/model.ts";
import { previewLine } from "../shared/preview";
import { agentRows, liveDesksLabel, type AgentRowModel } from "../phone/model";

/** One row of the Agents column, a Slack DM: the phone's agent row (live desks, running, waiting) and a one-line preview. */
export interface AgentDmRow extends AgentRowModel {
  preview: string;
}

/**
 * The Agents column's rows in the daemon's order (chat_agents) (plan 013 U10): the phone's agentRows, with the first
 * line of the agent's newest reply as the preview — what it said last, as a DM does — else its live desks.
 */
export function agentDmRows(
  agents: Array<{ id: string; name: string }>,
  desks: Array<{ agent_id: string | null; status: string }>,
  items: AttentionItem[],
): AgentDmRow[] {
  return agentRows(agents, desks, items).map((r) => {
    const newest = items
      .filter((i) => i.agent_id === r.id && !i.archived && i.lastAssistantText?.trim())
      .reduce<AttentionItem | null>((best, i) => (!best || (i.last_message_at ?? "") > (best.last_message_at ?? "") ? i : best), null);
    const said = previewLine(newest?.lastAssistantText);
    return { ...r, preview: said || liveDesksLabel(r.live) };
  });
}
