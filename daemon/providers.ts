import type { Credential, CredentialStore } from "@earendil-works/pi-ai";
import type { Models } from "@earendil-works/pi-ai/models";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { ConnectProvider } from "../core/attention/protocol.ts";

const NO_SIGN_IN = new Set(["anthropic"]);
export const SIGN_IN_MS = 10 * 60_000;

interface Waiting {
  abort: AbortController;
  code?: (input: string) => void;
}

export class Providers {
  private readonly models: Models;
  private readonly credentials: CredentialStore;
  private readonly report: (message: string) => void;
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
    const shown = this.models.getProviders().filter((p) => (p.auth.apiKey?.login ? true : this.signsIn(p.id)));
    const checks = await Promise.all(shown.map((p) => this.models.checkAuth(p.id).catch(() => undefined)));
    const out: ConnectProvider[] = [];
    for (const [i, p] of shown.entries()) {
      const key = p.auth.apiKey?.login ? p.auth.apiKey : undefined;
      const signIn = this.signsIn(p.id) ? p.auth.oauth : undefined;
      const check = checks[i];
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

  async connectKey(providerId: string, key: string): Promise<void> {
    const provider = this.models.getProvider(providerId);
    if (!provider?.auth.apiKey) throw new Error(`${providerId} does not take an API key`);
    if (!key.trim()) throw new Error("the key is empty");
    let previous: Credential | undefined;
    await this.credentials.modify(providerId, (current) => {
      previous = current;
      return Promise.resolve({ type: "api_key", key: key.trim() });
    });
    const refreshed = await this.models.refresh({ providers: [providerId] });
    const error = refreshed.errors.get(providerId);
    if (error) {
      const kept = previous;
      if (kept) {
        await this.credentials.modify(providerId, () => Promise.resolve(kept));
        await this.models.refresh({ providers: [providerId] }).catch(() => undefined);
      } else await this.credentials.delete(providerId);
      throw new Error(`${provider.name} did not accept the key${kept ? " (the one kept before is still in use)" : ""}: ${error.message}`);
    }
  }

  async disconnect(providerId: string): Promise<void> {
    await this.credentials.delete(providerId);
  }

  signIn(providerId: string): Promise<{ url: string; instructions: string | null }> {
    if (!this.signsIn(providerId)) return Promise.reject(new Error(`loki does not sign in to ${providerId}`));
    this.waiting.get(providerId)?.abort.abort(new Error("a new sign-in started"));
    const entry: Waiting = { abort: new AbortController() };
    this.waiting.set(providerId, entry);
    const timer = setTimeout(() => entry.abort.abort(new Error("the sign-in was not finished in time")), SIGN_IN_MS);
    timer.unref();
    return new Promise((resolve, reject) => {
      let named = false;
      const done = this.models.login(
        providerId,
        "oauth",
        {
          signal: entry.abort.signal,
          prompt: (prompt) => {
            if (prompt.type === "select") return Promise.resolve(prompt.options[0]?.id ?? "");
            // Outside (pi-ai): GitHub Copilot's sign-in first asks for an Enterprise domain, left blank for github.com.
            if (prompt.type === "text") return Promise.resolve("");
            if (prompt.type !== "manual_code") return Promise.reject(new Error("this sign-in asks for something loki cannot answer; use an API key"));
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
      done
        .then(
          () => this.report(`signed in to ${providerId}`),
          (error: unknown) => {
            this.report(`sign-in to ${providerId} ended: ${String(error)}`);
            if (!named) reject(error instanceof Error ? error : new Error(String(error)));
          },
        )
        .finally(() => {
          clearTimeout(timer);
          if (this.waiting.get(providerId) === entry) this.waiting.delete(providerId);
        });
    });
  }

  finishSignIn(providerId: string, code: string): void {
    const entry = this.waiting.get(providerId);
    if (!entry?.code) throw new Error(`no sign-in to ${providerId} is waiting`);
    if (!code.trim()) throw new Error("paste the address the browser ended on");
    entry.code(code.trim());
  }
}

export function deviceIdIn(file: string): () => string {
  return () => {
    try {
      const kept = readFileSync(file, "utf8").trim();
      if (/^[0-9a-f-]{36}$/i.test(kept)) return kept;
    } catch {}
    const id = randomUUID();
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${id}\n`);
    return id;
  };
}
