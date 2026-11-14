import type { ReactNode } from "react";
import type { AttentionItem } from "../../../core/attention/model.ts";
import { agentRows } from "../phone/model";
import type { PlaceSources } from "../shell/sidebar";
import { agentsSelection, shownAgent, type AgentsSelection, type AgentsSelectionState } from "./selection";

/** The Agents place's own row in the sidebar: it stands for no one agent, so choosing it keeps the agent shown. */
const AGENTS_PLACE = "";

/**
 * The agents as the Agents place's sources in the sidebar (plan 2026-11-14-1330, KTD9), in the daemon's order: each
 * one's face, its name, a green dot while a turn runs, and the count of what waits on you in Flow. The agent shown is
 * the selected source, none while the new-agent form is open. Choosing one selects it through the selection store and
 * leaves the page as it was, so the list and the detail move to the same page of another agent.
 */
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
  /** The selection's state as the caller last read it, so the sidebar re-renders with it. */
  state: AgentsSelectionState;
  face: (agentId: string, name: string) => ReactNode;
  selection?: AgentsSelection;
}): PlaceSources {
  const shown = state.creating ? null : shownAgent(state.agent, initialAgentId, agents);
  return {
    items: agentRows(agents, desks, items).map((r) => ({ id: r.id, title: r.name, face: face(r.id, r.name), count: r.waiting, live: r.running })),
    selected: shown ?? AGENTS_PLACE,
    all: AGENTS_PLACE,
    onSelect: (id) => {
      if (id !== AGENTS_PLACE) selection.pickAgent(id);
    },
  };
}
