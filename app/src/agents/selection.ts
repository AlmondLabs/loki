import { useSyncExternalStore } from "react";
import { AGENT_PAGE_KEY, DEFAULT_AGENT_PAGE, isAgentPage, type AgentPage } from "./pages";
import { firstAgentId } from "./reading";
import { Listeners } from "../../../core/listeners.ts";

export const AGENT_ID_KEY = "loki.agentsAgent";

export interface AgentsSelectionState {
  agent: string | null | undefined;
  page: AgentPage;
  creating: boolean;
}

export interface AgentsSelection {
  get: () => AgentsSelectionState;
  subscribe: (fn: () => void) => () => void;
  pickAgent: (id: string | null) => void;
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
  let state: AgentsSelectionState = { agent: savedAgent ?? undefined, page: isAgentPage(savedPage) ? savedPage : DEFAULT_AGENT_PAGE, creating: false };
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
      if (store) tryStore(() => (id ? store.setItem(AGENT_ID_KEY, id) : store.removeItem(AGENT_ID_KEY)), undefined);
      set({ agent: id, creating: false });
    },
    pickPage: (p) => {
      if (store) tryStore(() => store.setItem(AGENT_PAGE_KEY, p), undefined);
      set({ page: p });
    },
    setCreating: (on) => set({ creating: on }),
  };
}

export const agentsSelection = createAgentsSelection(tryStore(() => (typeof sessionStorage === "undefined" ? null : sessionStorage), null));

export function shownAgent(picked: string | null | undefined, initialAgentId: string | null, agents: ReadonlyArray<{ id: string }>): string | null {
  if (picked && agents.length && !agents.some((a) => a.id === picked)) picked = undefined;
  if (picked) return picked;
  if (picked === undefined && initialAgentId) return initialAgentId;
  return firstAgentId(agents);
}

export function agentsHasList(state: AgentsSelectionState, agentCount: number): boolean {
  return agentCount > 0 && !state.creating && state.page !== "profile";
}

export function useAgentsSelection(selection: AgentsSelection = agentsSelection): AgentsSelectionState {
  return useSyncExternalStore(selection.subscribe, selection.get, selection.get);
}
