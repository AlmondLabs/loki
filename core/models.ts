export const REASONING_EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

export interface ModelEntry {
  id: string;
  handle: string;
  label: string;
  description?: string;
  is_default?: boolean;
  is_featured?: boolean;
  reasoning_effort?: ReasoningEffort;
  /** False when the harness named the handles this account can reach and this is not one (`available_handles`). */
  available?: false;
  /** Among the models used lately (mod/models.ts): 0 is the latest. Set by the app, not the wire. */
  recent?: number;
}

export interface ChatEngineView {
  agent: string;
  name: string;
  model: string;
  modes: Array<{ id: string; name: string; description: string | null }>;
  commands: Array<{ name: string; description: string; hint: string | null }>;
}

export const acpPrefix = (agent: string) => `acp:${agent}/`;

export function harnessOf(handle: string | null | undefined): string | null {
  if (!handle?.startsWith("acp:")) return null;
  const slash = handle.indexOf("/");
  return slash > 4 ? handle.slice(4, slash) : null;
}

export interface Harness {
  id: string | null;
  name: string;
  locked: boolean;
}

export function harnesses(entries: ModelEntry[], chatHarness: string | null, started: boolean): Harness[] {
  const names = new Map<string | null, string>();
  for (const entry of entries) {
    const id = harnessOf(entry.handle);
    if (id === null) names.set(null, "loki");
    else if (entry.handle === `${acpPrefix(id)}default`) names.set(id, entry.label);
    else if (!names.has(id)) names.set(id, entry.label.split(" · ")[0] || id);
  }
  const ids = [...names.keys()].sort((a, b) => (a === null ? -1 : b === null ? 1 : 0));
  return ids.map((id) => ({ id, name: names.get(id) ?? id ?? "loki", locked: started && id !== chatHarness }));
}

export interface ModelSelection {
  id: string;
  handle: string;
  reasoning_effort?: ReasoningEffort;
}

export function selectionOf(entry: ModelEntry): ModelSelection {
  return { id: entry.id, handle: entry.handle, ...(entry.reasoning_effort ? { reasoning_effort: entry.reasoning_effort } : {}) };
}

export interface AppliedModel {
  handle: string;
  reasoning_effort: ReasoningEffort | null;
}

export function isReasoningEffort(value: unknown): value is ReasoningEffort {
  return typeof value === "string" && (REASONING_EFFORTS as readonly string[]).includes(value);
}

export function reasoningEffortFromSettings(value: unknown): ReasoningEffort | null {
  if (!value || typeof value !== "object") return null;
  const effort = (value as Record<string, unknown>).reasoning_effort;
  return isReasoningEffort(effort) ? effort : null;
}

export function withRecent(entries: ModelEntry[], recent: readonly string[]): ModelEntry[] {
  if (!recent.length) return entries;
  const rank = new Map(recent.map((h, i) => [h, i]));
  return entries.map((entry) => {
    const recentRank = rank.get(entry.handle);
    return recentRank === undefined ? entry : { ...entry, recent: recentRank };
  });
}
