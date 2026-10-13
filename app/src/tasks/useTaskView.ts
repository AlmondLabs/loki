import { useSyncExternalStore } from "react";
import { createSessionValue } from "../shared/sessionValue";
import { DEFAULT_PREFS, parsePrefs, parseTaskView, type TaskViewId, type ViewPrefs } from "./model";

/** The window's view from before the Board was called Tasks, carried over once so a reload keeps it. */
function carryOver(from: string, to: string): void {
  try {
    const was = sessionStorage.getItem(from);
    if (was !== null && sessionStorage.getItem(to) === null) sessionStorage.setItem(to, was);
    sessionStorage.removeItem(from);
  } catch {
    // Storage off: nothing to carry.
  }
}
carryOver("loki.boardView", "loki.tasksView");

/** The current view, shared by the sidebar and the pane, remembered for the window. */
const taskView = createSessionValue("loki.tasksView", parseTaskView);
export const useTaskView = taskView.use;

/**
 * Each view's layout (Board or Table), the Board's grouping and the Table's sort, on this device. A setting of the
 * view, not a view of its own: there are no saved views beyond the built-in ones.
 */
export const PREFS_KEY = "loki.tasks.layout";

function readAll(): Record<string, unknown> {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(PREFS_KEY) ?? "{}");
    return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** Agent views share one entry: an agent's tasks read the same way whoever the agent is. */
const prefsKey = (view: TaskViewId): string => (view.startsWith("agent:") ? "agent" : view);

let all = readAll();
const listeners = new Set<() => void>();
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => void listeners.delete(l);
};
const snapshot = () => all;

export function setViewPrefs(view: TaskViewId, change: Partial<ViewPrefs>): void {
  const key = prefsKey(view);
  all = { ...all, [key]: { ...parsePrefs(all[key]), ...change } };
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(all));
  } catch {
    // Storage off: the setting holds until the window closes.
  }
  for (const l of listeners) l();
}

/** A view's layout settings and their setter. */
export function useViewPrefs(view: TaskViewId): [ViewPrefs, (change: Partial<ViewPrefs>) => void] {
  const stored = useSyncExternalStore(subscribe, snapshot)[prefsKey(view)];
  return [stored === undefined ? DEFAULT_PREFS : parsePrefs(stored), (change) => setViewPrefs(view, change)];
}
