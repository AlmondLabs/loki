/**
 * The shapes a chat's live half speaks in (core/attention/chat-client.ts): which chat, the background passes' settings,
 * the model providers and. Their casing and names are the ones loki's app
 * grew up with, kept so the screens did not change when the daemon took over (plan 017).
 */
export interface Runtime {
  agent_id: string;
  conversation_id: string;
}
export type ServerEvent = Record<string, unknown> & { type: string; runtime?: Runtime };

/**
 * The background passes' settings (daemon/passes-state.ts, plan 018): reflection and Learn on or off, and the most
 * cards Learn writes in a day.
 */
export interface PassSettings {
  reflection: { enabled: boolean };
  learn: { enabled: boolean; dailyCap: number };
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
