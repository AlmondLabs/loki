/** Every reasoning effort a model preset may carry, least to most, in the order the model picker offers them. */
export const REASONING_EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
/** How hard a model thinks before answering, one of REASONING_EFFORTS. */
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

/** One model preset from the harness's list_models, as the model picker shows it: its handle, label, effort and whether this account can reach it. */
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

/**
 * The ACP agent a chat runs on, as the app shows it (plan 020): its name, the model it was given, and what the agent
 * offers in this chat, its own permission modes and slash commands (KD10). Null on loki's own engine.
 */
export interface ChatEngineView {
  agent: string;
  name: string;
  model: string;
  modes: Array<{ id: string; name: string; description: string | null }>;
  commands: Array<{ name: string; description: string; hint: string | null }>;
}

/** The model handle prefix of an ACP agent's models (`acp:<agent>/<model>`, daemon/acp/agents.ts). */
export const acpPrefix = (agent: string) => `acp:${agent}/`;

/** A model's harness (plan 021): the ACP agent's id for `acp:<agent>/<model>`, null for loki's own models. */
export function harnessOf(handle: string | null | undefined): string | null {
  if (!handle?.startsWith("acp:")) return null;
  const slash = handle.indexOf("/");
  return slash > 4 ? handle.slice(4, slash) : null;
}

/** One tab of Select model: loki (id null) or an ACP agent, and whether the chat can still move to it. */
export interface Harness {
  id: string | null;
  name: string;
  /** The chat has started on another harness, so it stays there (plan 020, KD4). */
  locked: boolean;
}

/**
 * The harnesses the entries offer, loki first, then each ACP agent in the order its models come. An agent is called
 * by its default model's label (the daemon names it after the agent), else by the label before " · ". Once the chat
 * has started, every harness but its own is locked.
 */
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

/** A concrete list_models preset. The id preserves provider-specific settings attached to that preset. */
export interface ModelSelection {
  id: string;
  handle: string;
  reasoning_effort?: ReasoningEffort;
}

/** The wire choice for one list_models preset. */
export function selectionOf(entry: ModelEntry): ModelSelection {
  return { id: entry.id, handle: entry.handle, ...(entry.reasoning_effort ? { reasoning_effort: entry.reasoning_effort } : {}) };
}

/** The model a conversation was switched to: the handle and effort sent with chat_model, effort null when none was chosen. */
export interface AppliedModel {
  handle: string;
  reasoning_effort: ReasoningEffort | null;
}

/** Whether a value is one of the reasoning efforts, for checking one read off the wire. */
export function isReasoningEffort(value: unknown): value is ReasoningEffort {
  return typeof value === "string" && (REASONING_EFFORTS as readonly string[]).includes(value);
}

/** The agent's own effort, as its record's `model_settings` keeps it (`reasoning_effort`); null leaves the model's. */
export function reasoningEffortFromSettings(value: unknown): ReasoningEffort | null {
  if (!value || typeof value !== "object") return null;
  const effort = (value as Record<string, unknown>).reasoning_effort;
  return isReasoningEffort(effort) ? effort : null;
}

/** The entries with each handle's place among the models used lately (`recent`, 0 the latest); the rest unmarked. */
export function withRecent(entries: ModelEntry[], recent: readonly string[]): ModelEntry[] {
  if (!recent.length) return entries;
  const rank = new Map(recent.map((h, i) => [h, i]));
  return entries.map((entry) => {
    const recentRank = rank.get(entry.handle);
    return recentRank === undefined ? entry : { ...entry, recent: recentRank };
  });
}
