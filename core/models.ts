export const REASONING_EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

export interface ModelEntry {
  id: string;
  handle: string;
  label: string;
  description?: string;
  isDefault?: boolean;
  isFeatured?: boolean;
  reasoningEffort?: ReasoningEffort;
}

/** A concrete list_models preset. The id preserves provider-specific settings attached to that preset. */
export interface ModelSelection {
  id: string;
  handle: string;
  reasoningEffort?: ReasoningEffort;
}

/** The wire choice for one list_models preset. */
export function selectionOf(entry: ModelEntry): ModelSelection {
  return { id: entry.id, handle: entry.handle, ...(entry.reasoningEffort ? { reasoningEffort: entry.reasoningEffort } : {}) };
}

export interface AppliedModel {
  handle: string;
  reasoningEffort: ReasoningEffort | null;
}

export function isReasoningEffort(value: unknown): value is ReasoningEffort {
  return typeof value === "string" && (REASONING_EFFORTS as readonly string[]).includes(value);
}

/** Normalize the list_models wire entries while retaining effort metadata from each preset. */
export function modelEntriesFromWire(value: unknown): ModelEntry[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((raw) => {
    if (!raw || typeof raw !== "object") return [];
    const entry = raw as Record<string, unknown>;
    const id = String(entry.id ?? entry.handle ?? "");
    const handle = String(entry.handle ?? entry.id ?? "");
    if (!handle) return [];
    const updateArgs = entry.updateArgs && typeof entry.updateArgs === "object" ? (entry.updateArgs as Record<string, unknown>) : null;
    const base: ModelEntry = {
      id,
      handle,
      label: String(entry.label ?? entry.handle ?? ""),
      ...(typeof entry.description === "string" ? { description: entry.description } : {}),
      ...(entry.isDefault === true ? { isDefault: true } : {}),
      ...(entry.isFeatured === true ? { isFeatured: true } : {}),
    };
    const efforts = reasoningEffortsFromWireEntry(entry, updateArgs, handle);
    return efforts.length ? efforts.map((reasoningEffort) => ({ ...base, reasoningEffort })) : [base];
  });
}

function reasoningEffortsFromWireEntry(entry: Record<string, unknown>, updateArgs: Record<string, unknown> | null, handle: string): ReasoningEffort[] {
  if (updateArgs && isReasoningEffort(updateArgs.reasoning_effort)) return [updateArgs.reasoning_effort];

  const capabilities = entry.reasoning_capabilities && typeof entry.reasoning_capabilities === "object" ? (entry.reasoning_capabilities as Record<string, unknown>) : null;
  const advertised = Array.isArray(entry.reasoning_levels)
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
  if (updateArgs?.provider_type === "chatgpt_oauth") return chatGptOAuthEfforts(handle);
  return [];
}

function chatGptOAuthEfforts(handle: string): ReasoningEffort[] {
  const model = handle.slice(handle.lastIndexOf("/") + 1).replace(/-fast$/, "");
  if (model.startsWith("gpt-5.6")) return ["none", "low", "medium", "high", "xhigh", "max"];
  if (model.startsWith("gpt-6")) return ["low", "medium", "high", "xhigh", "max"];
  return ["none", "low", "medium", "high", "xhigh"];
}

/** Read the applied level from the provider-specific model_settings shapes Letta persists. */
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
