import type { ConnectProvider, ProviderField } from "../../../core/attention/protocol.ts";

/**
 * Pure helpers for the provider rows: which fields a connect form shows, whether it can be
 * submitted, how the catalogue is ordered. The catalogue itself comes from the harness.
 */

/** The ones most people start with; shown first on the Welcome sheet. */
export const SHORTLIST = ["anthropic", "openai", "google", "openrouter", "ollama"];

export const isConnected = (p: ConnectProvider): boolean => p.connected?.is_connected === true;

/** OAuth entries have no fields the app can collect; they connect in the terminal. */
export const needsTerminal = (p: ConnectProvider): boolean => p.is_oauth === true || (!p.fields?.length && !p.auth_methods?.length && p.requires_api_key);

/** The fields for a provider, given the chosen auth method (the first one by default). */
export function fieldsFor(p: ConnectProvider, authMethodId?: string | null): { authMethodId: string | null; fields: ProviderField[] } {
  if (p.auth_methods?.length) {
    const m = p.auth_methods.find((a) => a.id === authMethodId) ?? p.auth_methods[0];
    return { authMethodId: m.id, fields: m.fields ?? [] };
  }
  return { authMethodId: null, fields: p.fields ?? [] };
}

/** Every required field filled (whitespace does not count). */
export function canConnect(fields: ProviderField[], values: Record<string, string>): boolean {
  return fields.every((f) => !f.required || !!values[f.key]?.trim());
}

/** Only the fields the form shows, trimmed; empty optional fields are dropped. */
export function fieldValues(fields: ProviderField[], values: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of fields) {
    const v = values[f.key]?.trim();
    if (v) out[f.key] = v;
  }
  return out;
}

/** Connected first, then the shortlist in its order, then the rest alphabetically; a filter narrows by name or id. */
export function sortProviders(list: ConnectProvider[], filter = ""): ConnectProvider[] {
  const q = filter.trim().toLowerCase();
  const rank = (p: ConnectProvider) => (isConnected(p) ? 0 : SHORTLIST.includes(p.id) ? 1 + SHORTLIST.indexOf(p.id) : 100);
  return list
    .filter((p) => !q || p.display_name.toLowerCase().includes(q) || p.id.includes(q) || (p.description ?? "").toLowerCase().includes(q))
    .sort((a, b) => rank(a) - rank(b) || a.display_name.localeCompare(b.display_name));
}

/** What the first launch still needs: nothing, a provider, or an agent. */
export function welcomeStep(opts: { agents: number; providers: ConnectProvider[] | null }): "provider" | "agent" | null {
  if (opts.agents > 0) return null;
  if (opts.providers && !opts.providers.some(isConnected)) return "provider";
  return "agent";
}
