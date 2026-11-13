import { useEffect, useRef, useSyncExternalStore } from "react";
import type { ModelEntry, ModelSelection, ReasoningEffort } from "../../../core/models.ts";
import type { UsualChoice } from "../chat/model-switcher";

/**
 * ⌘K as loki's one command panel (plan 2026-11-12-1505, U23). The open chat shares its model controls here, as views
 * share their actions with the keymap, so ⌘K's Models scope reads them without a copy of the chat's state; and
 * anything (the model pill, ⌘⇧M) can open ⌘K on a scope.
 */

/** ⌘K's scopes: everything, or only the open chat's models. */
export type CommandScope = "all" | "models";

/** What the open chat shares for switching its model: what it offers, what it is on, and how to switch. */
export interface SharedModels {
  entries: ModelEntry[] | null;
  current: string | null;
  currentEffort: ReasoningEffort | null;
  started: boolean;
  usual: readonly UsualChoice[];
  /** The chat's agent, for the scope's heading. */
  agentName: string | null;
  pick: (selection: ModelSelection) => void;
}

type Listener = () => void;
const listeners = new Set<Listener>();
/** The chats sharing, the latest mounted last: ⌘K reads the last. */
const shared: Array<{ id: number; models: SharedModels }> = [];
let next = 1;
let snapshot: SharedModels | null = null;

const changed = () => {
  snapshot = shared.at(-1)?.models ?? null;
  for (const fn of listeners) fn();
};

/** The models the open chat shares, or null with none open; re-renders when they change. */
export function useSharedModels(): SharedModels | null {
  return useSyncExternalStore(
    (fn) => (listeners.add(fn), () => listeners.delete(fn)),
    () => snapshot,
    () => null,
  );
}

/**
 * Share a chat's model controls while `models` is given (Liquid Glass on the desktop); its switch is read through a
 * ref, so a fresh closure each render does not count as a change.
 */
export function useShareModels(models: SharedModels | null): void {
  const pick = useRef(models?.pick);
  useEffect(() => {
    pick.current = models?.pick;
  });
  const on = models !== null;
  const { entries = null, current = null, currentEffort = null, started = false, usual = NONE, agentName = null } = models ?? {};
  useEffect(() => {
    if (!on) return;
    const id = next++;
    shared.push({ id, models: { entries, current, currentEffort, started, usual, agentName, pick: (s) => pick.current?.(s) } });
    changed();
    return () => {
      const at = shared.findIndex((x) => x.id === id);
      if (at >= 0) shared.splice(at, 1);
      changed();
    };
  }, [on, entries, current, currentEffort, started, usual, agentName]);
}

const NONE: readonly UsualChoice[] = [];

/** Who opens ⌘K: the shell, which owns the panel. */
let opener: ((scope: CommandScope) => void) | null = null;

/** The shell takes the opening of ⌘K; returns the release. */
export function takeCommandCenter(open: (scope: CommandScope) => void): () => void {
  opener = open;
  return () => {
    if (opener === open) opener = null;
  };
}

/** Open ⌘K on a scope (the model pill, ⌘⇧M); false when no shell is there to open it. */
export function openCommandCenter(scope: CommandScope): boolean {
  if (!opener) return false;
  opener(scope);
  return true;
}
