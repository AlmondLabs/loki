import type { ConnectProvider, ProviderField } from "../../../core/attention/protocol.ts";

export const SHORTLIST = ["anthropic", "openai", "google", "openrouter", "ollama"];

export const isConnected = (p: ConnectProvider): boolean => p.connected.is_connected;

export function fieldsFor(p: ConnectProvider, authMethodId?: string | null): { authMethodId: string | null; fields: ProviderField[] } {
  if (p.auth_methods?.length) {
    const m = p.auth_methods.find((a) => a.id === authMethodId) ?? p.auth_methods[0];
    return { authMethodId: m.id, fields: m.fields };
  }
  return { authMethodId: null, fields: p.fields ?? [] };
}

export function canConnect(fields: ProviderField[], values: Partial<Record<string, string>>): boolean {
  return fields.every((f) => !f.required || !!values[f.key]?.trim());
}

export function fieldValues(fields: ProviderField[], values: Partial<Record<string, string>>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of fields) {
    const v = values[f.key]?.trim();
    if (v) out[f.key] = v;
  }
  return out;
}

export function sortProviders(list: ConnectProvider[], filter = ""): ConnectProvider[] {
  const q = filter.trim().toLowerCase();
  const rank = (p: ConnectProvider) => (isConnected(p) ? 0 : SHORTLIST.includes(p.id) ? 1 + SHORTLIST.indexOf(p.id) : 100);
  return list
    .filter((p) => !q || p.display_name.toLowerCase().includes(q) || p.id.includes(q) || (p.description ?? "").toLowerCase().includes(q))
    .sort((a, b) => rank(a) - rank(b) || a.display_name.localeCompare(b.display_name));
}

export function welcomeStep(opts: { agents: number; providers: ConnectProvider[] | null }): "provider" | "agent" | null {
  if (opts.agents > 0) return null;
  if (opts.providers && !opts.providers.some(isConnected)) return "provider";
  return "agent";
}
