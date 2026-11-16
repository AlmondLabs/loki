export interface Runtime {
  agent_id: string;
  conversation_id: string;
}
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
