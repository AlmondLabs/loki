import type { CredentialStore } from "@earendil-works/pi-ai";
import type { Models } from "@earendil-works/pi-ai/models";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
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
/** How long a sign-in waits for the browser. */
export const SIGN_IN_MS = 10 * 60_000;

type Waiting = { abort: AbortController; code?: (input: string) => void };

export class Providers {
  private readonly models: Models;
  private readonly credentials: CredentialStore;
  private readonly report: (message: string) => void;
  /** This install's stable id, which "Sign in with ChatGPT" sends OpenAI as its agent host. */
  private readonly deviceId: () => string;
  private readonly waiting = new Map<string, Waiting>();

  constructor(models: Models, credentials: CredentialStore, report: (message: string) => void = () => {}, deviceId: () => string = () => randomUUID()) {
    this.models = models;
    this.credentials = credentials;
    this.report = report;
    this.deviceId = deviceId;
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
   * while the sign-in goes on until the browser comes back; its credential is kept when it does. Where the provider
   * offers a choice, the browser is chosen. A new sign-in to a provider replaces one still waiting (both would want
   * the same callback port), and one left waiting gives up after SIGN_IN_MS.
   */
  signIn(providerId: string): Promise<{ url: string; instructions: string | null }> {
    if (!this.signsIn(providerId)) return Promise.reject(new Error(`loki does not sign in to ${providerId}`));
    this.waiting.get(providerId)?.abort.abort(new Error("a new sign-in started"));
    const entry: Waiting = { abort: new AbortController() };
    this.waiting.set(providerId, entry);
    const timer = setTimeout(() => entry.abort.abort(new Error("the sign-in was not finished in time")), SIGN_IN_MS);
    timer.unref?.();
    return new Promise((resolve, reject) => {
      let named = false;
      const done = this.models.login(
        providerId,
        "oauth",
        {
          signal: entry.abort.signal,
          prompt: (prompt) => {
            if (prompt.type === "select") return Promise.resolve(prompt.options[0]?.id ?? "");
            if (prompt.type !== "manual_code") return Promise.reject(new Error("this sign-in asks for something loki cannot answer; use an API key"));
            // The browser's callback usually wins; the redirect URL pasted in Settings is the way when it cannot reach
            // this machine (signing in on another device).
            return new Promise<string>((answer, cancel) => {
              entry.code = answer;
              prompt.signal?.addEventListener("abort", () => cancel(new Error("the browser came back")), { once: true });
            });
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
        },
        { getDeviceId: this.deviceId, agentName: "loki" },
      );
      done.then(
        () => this.report(`signed in to ${providerId}`),
        (error: unknown) => {
          this.report(`sign-in to ${providerId} ended: ${String(error)}`);
          if (!named) reject(error instanceof Error ? error : new Error(String(error)));
        },
      ).finally(() => {
        clearTimeout(timer);
        if (this.waiting.get(providerId) === entry) this.waiting.delete(providerId);
      });
    });
  }

  /** The redirect URL (or code) the browser ended on, for a sign-in whose callback never reached this machine. */
  finishSignIn(providerId: string, code: string): void {
    const entry = this.waiting.get(providerId);
    if (!entry?.code) throw new Error(`no sign-in to ${providerId} is waiting`);
    if (!code.trim()) throw new Error("paste the address the browser ended on");
    entry.code(code.trim());
  }
}

/** The install's id, made on first use and kept in `file`. */
export function deviceIdIn(file: string): () => string {
  return () => {
    try {
      const kept = readFileSync(file, "utf8").trim();
      if (/^[0-9a-f-]{36}$/i.test(kept)) return kept;
    } catch {
      // made below
    }
    const id = randomUUID();
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${id}\n`);
    return id;
  };
}
