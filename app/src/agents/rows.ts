import type { AttentionItem } from "../../../core/attention/model.ts";
import { agentRows, liveDesksLabel, type AgentRowModel } from "../phone/model";

/** One row of the Agents column, a Slack DM: the phone's agent row (live desks, running, waiting) and a one-line preview. */
export interface AgentDmRow extends AgentRowModel {
  preview: string;
}

/**
 * The Agents column's rows in the app-server's order (plan 013 U10): the phone's agentRows, with the first
 * line of the agent's newest reply as the preview — what it said last, as a DM does — else its live desks.
 */
export function agentDmRows(agents: Array<{ id: string; name: string }>, desks: Array<{ agentId: string | null; status: string }>, items: AttentionItem[]): AgentDmRow[] {
  return agentRows(agents, desks, items).map((r) => {
    const newest = items
      .filter((i) => i.agentId === r.id && !i.archived && i.lastAssistantText?.trim())
      .reduce<AttentionItem | null>((best, i) => (!best || (i.lastMessageAt ?? "") > (best.lastMessageAt ?? "") ? i : best), null);
    const said = newest?.lastAssistantText?.trim().split("\n")[0].trim();
    return { ...r, preview: said || liveDesksLabel(r.live) };
  });
}
