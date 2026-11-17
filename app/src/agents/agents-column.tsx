import type { ReactNode } from "react";
import type { AttentionItem } from "../../../core/attention/model.ts";
import { agentRows } from "../phone/model";
import type { PlaceSources } from "../shell/sidebar";
import { agentsSelection, shownAgent, type AgentsSelection, type AgentsSelectionState } from "./selection";

const NO_AGENT = "";

export function agentSources({
  agents,
  desks,
  items,
  initialAgentId,
  state,
  face,
  selection = agentsSelection,
}: {
  agents: Array<{ id: string; name: string }>;
  desks: Array<{ agent_id: string | null; status: string }>;
  items: AttentionItem[];
  initialAgentId: string | null;
  state: AgentsSelectionState;
  face: (agentId: string, name: string) => ReactNode;
  selection?: AgentsSelection;
}): PlaceSources {
  const shown = state.creating ? null : shownAgent(state.agent, initialAgentId, agents);
  return {
    items: agentRows(agents, desks, items).map((r) => ({ id: r.id, title: r.name, face: face(r.id, r.name), count: r.waiting, live: r.running })),
    selected: shown ?? NO_AGENT,
    onSelect: (id) => {
      if (id !== NO_AGENT) selection.pickAgent(id);
    },
  };
}
