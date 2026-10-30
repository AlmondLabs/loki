/**
 * The shapes a chat's live half speaks in (core/attention/chat-client.ts): which chat, the background passes' settings,
 * and the model providers. Their casing and names are the ones loki's app
 * grew up with, kept so the screens did not change when the daemon took over (plan 017).
 */
export interface Runtime {
  agent_id: string;
  conversation_id: string;
}
/** An event the chat client hands back, loosely typed: its `type` and, for one about a chat, that chat's runtime. runtimeStart answers with one. */
export type ServerEvent = Record<string, unknown> & { type: string; runtime?: Runtime };

/**
 * The background passes' settings (daemon/passes-state.ts, plan 018): reflection and Learn on or off, the most cards
 * Learn writes in a day, and whether an agent with no model loki can reach runs them on its ACP agent (plan 061).
 */
export interface PassSettings {
  reflection: { enabled: boolean };
  learn: { enabled: boolean; daily_cap: number };
  acp: { enabled: boolean };
}

/** A change to the passes' settings, as the app sends it: only the parts given change. */
export interface PassSettingsChange {
  reflection?: { enabled: boolean };
  learn?: { enabled?: boolean; daily_cap?: number };
  acp?: { enabled: boolean };
}

/** One credential the harness asks for when connecting a provider. */
export interface ProviderField {
  key: string;
  label: string;
  placeholder?: string;
  secret?: boolean;
  required?: boolean;
}
/** One way of signing in to a provider (an API key, OAuth), with the credentials it asks for. */
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
