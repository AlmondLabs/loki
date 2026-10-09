import type { CredentialStore } from "@earendil-works/pi-ai";
import type { Models } from "@earendil-works/pi-ai/models";
import type { ConnectProvider } from "../core/attention/protocol.ts";

/**
 * Model providers on loki's daemon (plan 017, U8): the ones pi-ai knows, each connected with an API key or by signing
 * in through the browser, its credential kept in the keychain (daemon/credentials.ts). Settings › providers reads and
 * changes them in the shape it read from Letta (ConnectProvider). A key is tried before it is kept, by listing the
 * provider's models where the provider lists them over the network. Anthropic's subscription sign-in is not offered:
 * pi-ai implements it by presenting itself as Claude Code (KTD10).
 */

/** Sign-in methods loki does not offer, by provider. */
const NO_SIGN_IN = new Set(["anthropic"]);

export class Providers {
  private readonly models: Models;
  private readonly credentials: CredentialStore;
  private readonly report: (message: string) => void;

  constructor(models: Models, credentials: CredentialStore, report: (message: string) => void = () => {}) {
    this.models = models;
    this.credentials = credentials;
    this.report = report;
  }

  private signsIn(id: string): boolean {
    return Boolean(this.models.getProvider(id)?.auth.oauth) && !NO_SIGN_IN.has(id);
  }

  async list(): Promise<ConnectProvider[]> {
    const out: ConnectProvider[] = [];
    for (const p of this.models.getProviders()) {
      const key = p.auth.apiKey?.login ? p.auth.apiKey : undefined;
      const signIn = this.signsIn(p.id) ? p.auth.oauth : undefined;
      if (!key && !signIn) continue;
      const check = await this.models.checkAuth(p.id).catch(() => undefined);
      const methods = [
        ...(key ? [{ id: "api_key", label: "API key", fields: [{ key: "api_key", label: key.name || "API key", secret: true, required: true }] }] : []),
        ...(signIn ? [{ id: "oauth", label: signIn.loginLabel ?? "Sign in", description: signIn.name, fields: [] }] : []),
      ];
      out.push({
        id: p.id,
        display_name: p.name,
        provider_type: p.id,
        provider_name: p.id,
        requires_api_key: Boolean(key),
        auth_methods: methods,
        connected: check ? { is_connected: true, id: p.id, provider_name: p.id, provider_type: p.id, auth_type: check.type } : { is_connected: false },
      });
    }
    return out;
  }

  /** Keep an API key, once the provider has accepted it. */
  async connectKey(providerId: string, key: string): Promise<void> {
    const provider = this.models.getProvider(providerId);
    if (!provider?.auth.apiKey) throw new Error(`${providerId} does not take an API key`);
    if (!key.trim()) throw new Error("the key is empty");
    await this.credentials.modify(providerId, async () => ({ type: "api_key", key: key.trim() }));
    const refreshed = await this.models.refresh({ providers: [providerId] });
    const error = refreshed.errors.get(providerId);
    if (error) {
      await this.credentials.delete(providerId);
      throw new Error(`${provider.name} did not accept the key: ${error.message}`);
    }
  }

  async disconnect(providerId: string): Promise<void> {
    await this.credentials.delete(providerId);
  }

  /**
   * Start signing in: resolves with the page to open (or the code to enter there) as soon as the provider names it,
   * while the sign-in goes on until the browser comes back; its credential is kept when it does.
   */
  signIn(providerId: string): Promise<{ url: string; instructions: string | null }> {
    if (!this.signsIn(providerId)) return Promise.reject(new Error(`loki does not sign in to ${providerId}`));
    return new Promise((resolve, reject) => {
      let named = false;
      const done = this.models.login(providerId, "oauth", {
        prompt: async () => {
          throw new Error("this sign-in asks for something loki cannot answer; use an API key");
        },
        notify: (event) => {
          if (named) return;
          if (event.type === "auth_url") {
            named = true;
            resolve({ url: event.url, instructions: event.instructions ?? null });
          } else if (event.type === "device_code") {
            named = true;
            resolve({ url: event.verificationUri, instructions: `Enter the code ${event.userCode}` });
          }
        },
      });
      done.then(
        () => this.report(`signed in to ${providerId}`),
        (error: unknown) => {
          this.report(`sign-in to ${providerId} failed: ${String(error)}`);
          if (!named) reject(error instanceof Error ? error : new Error(String(error)));
        },
      );
    });
  }
}
