import { useSyncExternalStore } from "react";
import { AGENT_PAGE_KEY, DEFAULT_AGENT_PAGE, isAgentPage, type AgentPage } from "./pages";
import { firstAgentId } from "./reading";

/** The agent last chosen, kept for the window beside the page (sessionStorage). */
export const AGENT_ID_KEY = "loki.agentsAgent";

/**
 * What the Agents column and pane both read (plan 013 U10): the chosen agent, its page, and whether the
 * new-agent form is open. They live in different parts of the Shell (the column stays mounted, the pane
 * mounts with the section), so the choice sits here rather than in either. `agent` is undefined before
 * any pick (the desk's agent shows) and null after the shown one is deleted (the first shows).
 */
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

/** A blocked store only costs remembering across reloads. */
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
  const subs = new Set<() => void>();
  const set = (next: Partial<AgentsSelectionState>) => {
    state = { ...state, ...next };
    for (const fn of subs) fn();
  };
  return {
    get: () => state,
    subscribe: (fn) => {
      subs.add(fn);
      return () => void subs.delete(fn);
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

/** The window's one selection: sessionStorage when there is one (not in tests or a blocked context). */
export const agentsSelection = createAgentsSelection(tryStore(() => (typeof sessionStorage === "undefined" ? null : sessionStorage), null));

/** The agent on show: the picked one; before any pick the desk's agent; else (none picked, or it was deleted) the first. */
export function shownAgent(picked: string | null | undefined, initialAgentId: string | null, agents: ReadonlyArray<{ id: string }>): string | null {
  if (picked) return picked;
  if (picked === undefined && initialAgentId) return initialAgentId;
  return firstAgentId(agents);
}

/** The selection's state, re-rendering on each change. */
export function useAgentsSelection(selection: AgentsSelection = agentsSelection): AgentsSelectionState {
  return useSyncExternalStore(selection.subscribe, selection.get, selection.get);
}
