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

/** A wire field as text: a string as it is, a number or boolean written out, anything else empty. */
const wireText = (v: unknown): string => (typeof v === "string" ? v : typeof v === "number" || typeof v === "boolean" ? String(v) : "");

/**
 * Normalize the list_models wire entries while retaining effort metadata from each preset. `availableHandles`
 * is the reply's `available_handles`: a list marks every other handle unavailable; null (the lookup failed) or
 * absent (an older harness) marks none.
 */
export function modelEntriesFromWire(value: unknown, availableHandles?: unknown): ModelEntry[] {
  if (!Array.isArray(value)) return [];
  const reachable = Array.isArray(availableHandles) ? new Set(availableHandles.filter((h): h is string => typeof h === "string")) : null;
  return value.flatMap((raw) => {
    if (!raw || typeof raw !== "object") return [];
    const entry = raw as Record<string, unknown>;
    const id = wireText(entry.id ?? entry.handle);
    const handle = wireText(entry.handle ?? entry.id);
    if (!handle) return [];
    const updateArgs = entry.updateArgs && typeof entry.updateArgs === "object" ? (entry.updateArgs as Record<string, unknown>) : null;
    const base: ModelEntry = {
      id,
      handle,
      label: wireText(entry.label ?? entry.handle),
      ...(typeof entry.description === "string" ? { description: entry.description } : {}),
      ...(entry.isDefault === true ? { is_default: true } : {}),
      ...(entry.isFeatured === true ? { is_featured: true } : {}),
      ...(reachable && !reachable.has(handle) ? { available: false as const } : {}),
    };
    const efforts = reasoningEffortsFromWireEntry(entry, updateArgs, handle);
    return efforts.length ? efforts.map((reasoningEffort) => ({ ...base, reasoning_effort: reasoningEffort })) : [base];
  });
}

function reasoningEffortsFromWireEntry(entry: Record<string, unknown>, updateArgs: Record<string, unknown> | null, handle: string): ReasoningEffort[] {
  if (updateArgs && isReasoningEffort(updateArgs.reasoning_effort)) return [updateArgs.reasoning_effort];

  const capabilities =
    entry.reasoning_capabilities && typeof entry.reasoning_capabilities === "object" ? (entry.reasoning_capabilities as Record<string, unknown>) : null;
  const advertised: unknown[] | null = Array.isArray(entry.reasoning_levels)
    ? entry.reasoning_levels
    : Array.isArray(entry.reasoningLevels)
      ? entry.reasoningLevels
      : Array.isArray(capabilities?.supported_efforts)
        ? capabilities.supported_efforts
        : null;
  if (advertised) {
    const normalized = new Set<ReasoningEffort>();
    for (const level of advertised) {
      const effort = level === "off" ? "none" : level;
      if (isReasoningEffort(effort) && !(capabilities?.mandatory === true && effort === "none")) normalized.add(effort);
    }
    return REASONING_EFFORTS.filter((effort) => normalized.has(effort));
  }

  // Letta Code 0.32.6 removes `reasoning_levels` while building list_models, but still marks
  // ChatGPT OAuth rows and accepts reasoning_effort for them in update_model. Keep this fallback
  // narrower than the provider: these are the distinct levels its bundled OpenAI registry exposes.
  if (updateArgs?.provider_type === "chatgpt_oauth") return chatGptOauthEfforts(handle);
  return [];
}

function chatGptOauthEfforts(handle: string): ReasoningEffort[] {
  const model = handle.slice(handle.lastIndexOf("/") + 1).replace(/-fast$/, "");
  if (model.startsWith("gpt-5.6")) return ["none", "low", "medium", "high", "xhigh", "max"];
  if (model.startsWith("gpt-6")) return ["low", "medium", "high", "xhigh", "max"];
  return ["none", "low", "medium", "high", "xhigh"];
}

/** Read the applied level from the provider-specific model_settings shapes Letta persisted (imported agent records carry them). */
export function reasoningEffortFromSettings(value: unknown): ReasoningEffort | null {
  if (!value || typeof value !== "object") return null;
  const settings = value as Record<string, unknown>;
  if (isReasoningEffort(settings.reasoning_effort)) return settings.reasoning_effort;
  if (isReasoningEffort(settings.effort)) return settings.effort;
  if (settings.reasoning && typeof settings.reasoning === "object") {
    const effort = (settings.reasoning as Record<string, unknown>).reasoning_effort;
    if (isReasoningEffort(effort)) return effort;
  }
  if (settings.thinking && typeof settings.thinking === "object" && (settings.thinking as Record<string, unknown>).type === "disabled") return "none";
  return null;
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
