import { useSyncExternalStore } from "react";
import { AGENT_PAGE_KEY, DEFAULT_AGENT_PAGE, isAgentPage, type AgentPage } from "./pages";
import { firstAgentId } from "./reading";
import { Listeners } from "../../../core/listeners.ts";

export const AGENT_ID_KEY = "loki.agentsAgent";

export type AgentPick = { kind: "none" } | { kind: "agent"; id: string } | { kind: "deleted" };

export interface AgentsSelectionState {
  agent: AgentPick;
  page: AgentPage;
  creating: boolean;
}

export interface AgentsSelection {
  get: () => AgentsSelectionState;
  subscribe: (fn: () => void) => () => void;
  pickAgent: (id: string) => void;
  agentDeleted: () => void;
  pickPage: (p: AgentPage) => void;
  setCreating: (on: boolean) => void;
}

type Store = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function tryStore<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

export function createAgentsSelection(store: Store | null): AgentsSelection {
  const savedPage = store ? tryStore(() => store.getItem(AGENT_PAGE_KEY), null) : null;
  const savedAgent = store ? tryStore(() => store.getItem(AGENT_ID_KEY), null) : null;
  let state: AgentsSelectionState = {
    agent: savedAgent ? { kind: "agent", id: savedAgent } : { kind: "none" },
    page: isAgentPage(savedPage) ? savedPage : DEFAULT_AGENT_PAGE,
    creating: false,
  };
  const subs = new Listeners();
  const set = (next: Partial<AgentsSelectionState>) => {
    state = { ...state, ...next };
    subs.emit();
  };
  return {
    get: () => state,
    subscribe: (fn) => {
      return subs.add(fn);
    },
    pickAgent: (id) => {
      if (store) tryStore(() => store.setItem(AGENT_ID_KEY, id), undefined);
      set({ agent: { kind: "agent", id }, creating: false });
    },
    agentDeleted: () => {
      if (store) tryStore(() => store.removeItem(AGENT_ID_KEY), undefined);
      set({ agent: { kind: "deleted" }, creating: false });
    },
    pickPage: (p) => {
      if (store) tryStore(() => store.setItem(AGENT_PAGE_KEY, p), undefined);
      set({ page: p });
    },
    setCreating: (on) => set({ creating: on }),
  };
}

export const agentsSelection = createAgentsSelection(tryStore(() => (typeof sessionStorage === "undefined" ? null : sessionStorage), null));

export function shownAgent(pick: AgentPick, initialAgentId: string | null, agents: ReadonlyArray<{ id: string }>): string | null {
  if (pick.kind === "agent" && (!agents.length || agents.some((a) => a.id === pick.id))) return pick.id;
  if (pick.kind !== "deleted" && initialAgentId) return initialAgentId;
  return firstAgentId(agents);
}

export function agentsHasList(state: AgentsSelectionState, agentCount: number): boolean {
  return agentCount > 0 && !state.creating && state.page !== "profile";
}

export function useAgentsSelection(selection: AgentsSelection = agentsSelection): AgentsSelectionState {
  return useSyncExternalStore(selection.subscribe, selection.get, selection.get);
}
