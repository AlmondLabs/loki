/**
 * The shapes a chat's live half speaks in (core/attention/chat-client.ts): which chat, the reflection settings, the
 * model providers and the personalities a new agent starts from. Their casing and names are the ones loki's app
 * grew up with, kept so the screens did not change when the daemon took over (plan 017).
 */
export interface Runtime {
  agent_id: string;
  conversation_id: string;
}
export type ServerEvent = Record<string, unknown> & { type: string; runtime?: Runtime };

/** Reflection: when a pass fires and how its changes land (ReflectionSettingsSnapshot, in loki's casing). */
export type ReflectionTrigger = "off" | "step-count" | "compaction-event";
export type ReflectionMerge = "auto" | "explicit";
export interface ReflectionSettings {
  trigger: ReflectionTrigger;
  /** Steps a conversation accumulates since its last pass before the step-count trigger fires. */
  stepCount: number;
  merge: ReflectionMerge;
  mergeInstructions: string;
}
export function parseReflectionSettings(v: unknown): ReflectionSettings | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const trigger = o.trigger === "off" || o.trigger === "step-count" || o.trigger === "compaction-event" ? o.trigger : "step-count";
  return { trigger, stepCount: typeof o.step_count === "number" && o.step_count > 0 ? Math.floor(o.step_count) : 25, merge: o.merge === "explicit" ? "explicit" : "auto", mergeInstructions: typeof o.merge_instructions === "string" ? o.merge_instructions : "" };
}

/** One credential the harness asks for when connecting a provider. */
export interface ProviderField {
  key: string;
  label: string;
  placeholder?: string;
  secret?: boolean;
  required?: boolean;
}
export interface ProviderAuthMethod {
  id: string;
  label: string;
  description?: string;
  fields: ProviderField[];
}
/** An entry of list_connect_providers. */
export interface ConnectProvider {
  id: string;
  display_name: string;
  description?: string;
  provider_type: string;
  provider_name: string;
  is_oauth?: boolean;
  oauth_provider_id?: string;
  requires_api_key: boolean;
  fields?: ProviderField[];
  auth_methods?: ProviderAuthMethod[];
  connected: { is_connected: boolean; id?: string; provider_name?: string; provider_type?: string; auth_type?: string };
}
/** Letta's personality presets accepted by create_agent. */
export type Personality = "memo" | "blank" | "tutorial" | "linus" | "kawaii";
export const PERSONALITIES: Array<{ id: Personality; label: string; description: string }> = [
  { id: "memo", label: "Letta Code", description: "the memory-first coding agent; what `letta` itself creates" },
  { id: "blank", label: "Blank", description: "no personality written; you or the agent fill in persona.md" },
  { id: "tutorial", label: "Tutor", description: "knows Letta, helps set up and configure agents" },
  { id: "linus", label: "Linus", description: "terse and exacting" },
  { id: "kawaii", label: "Kawaii", description: "cheerful" },
];
