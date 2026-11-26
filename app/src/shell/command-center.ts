import { useEffect, useRef, useSyncExternalStore } from "react";
import type { ModelEntry, ModelSelection, ReasoningEffort } from "../../../core/models.ts";
import type { UsualChoice } from "../chat/model-switcher";

export type CommandScope = "all" | "models" | "permissions";

export interface SharedMode {
  id: string;
  label: string;
  description: string;
}

export interface SharedModes {
  current: string | null;
  list: readonly SharedMode[];
  pick: (id: string) => void;
}

export interface SharedModels {
  entries: ModelEntry[] | null;
  current: string | null;
  currentEffort: ReasoningEffort | null;
  started: boolean;
  usual: readonly UsualChoice[];
  agentName: string | null;
  pick: (selection: ModelSelection) => void;
  modes?: SharedModes | null;
}

type Listener = () => void;
const listeners = new Set<Listener>();
const shared: Array<{ id: number; models: SharedModels }> = [];
let next = 1;
const nextModelId = () => next++;
let snapshot: SharedModels | null = null;

const changed = () => {
  snapshot = shared.at(-1)?.models ?? null;
  for (const fn of listeners) fn();
};

export function useSharedModels(): SharedModels | null {
  return useSyncExternalStore(
    (fn) => (listeners.add(fn), () => listeners.delete(fn)),
    () => snapshot,
    () => null,
  );
}

export function useShareModels(models: SharedModels | null): void {
  const pick = useRef(models?.pick);
  useEffect(() => {
    pick.current = models?.pick;
  });
  const modes = useRef(models?.modes ?? null);
  useEffect(() => {
    modes.current = models?.modes ?? null;
  });
  const shownModes = models?.modes ?? null;
  const modesKey = shownModes ? `${shownModes.current ?? ""}\n${shownModes.list.map((m) => `${m.id}\t${m.label}\t${m.description}`).join("\n")}` : null;
  const on = models !== null;
  const { entries = null, current = null, currentEffort = null, started = false, usual = NONE, agentName = null } = models ?? {};
  useEffect(() => {
    if (!on) return;
    const id = nextModelId();
    const now = modesKey === null ? null : modes.current;
    const sharedModes = now ? { current: now.current, list: now.list, pick: (m: string) => modes.current?.pick(m) } : null;
    shared.push({ id, models: { entries, current, currentEffort, started, usual, agentName, pick: (s) => pick.current?.(s), modes: sharedModes } });
    changed();
    return () => {
      const at = shared.findIndex((x) => x.id === id);
      if (at >= 0) shared.splice(at, 1);
      changed();
    };
  }, [on, entries, current, currentEffort, started, usual, agentName, modesKey]);
}

const NONE: readonly UsualChoice[] = [];

let opener: ((scope: CommandScope) => void) | null = null;

export function takeCommandCenter(open: (scope: CommandScope) => void): () => void {
  opener = open;
  return () => {
    if (opener === open) opener = null;
  };
}

export function openCommandCenter(scope: CommandScope): boolean {
  if (!opener) return false;
  opener(scope);
  return true;
}
