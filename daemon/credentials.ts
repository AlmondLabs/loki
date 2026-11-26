import type { Credential, CredentialInfo, CredentialStore } from "@earendil-works/pi-ai";
import { keyedQueue } from "../core/serial.ts";

export interface SecretBackend {
  get(account: string): Promise<string | null>;
  set(account: string, value: string): Promise<void>;
  delete(account: string): Promise<void>;
}

const SERVICE = "loki";
const INDEX = "providers";

export async function keychain(): Promise<SecretBackend> {
  const { Entry } = await import("@napi-rs/keyring");
  return {
    get: (account) => Promise.resolve(new Entry(SERVICE, account).getPassword()),
    set: (account, value) => Promise.resolve(new Entry(SERVICE, account).setPassword(value)),
    delete: (account) => {
      new Entry(SERVICE, account).deletePassword();
      return Promise.resolve();
    },
  };
}

export class KeychainCredentials implements CredentialStore {
  private readonly backend: SecretBackend;
  private readonly serial = keyedQueue();
  private cachedIndex: string[] | null = null;
  private readonly cache = new Map<string, Credential | undefined>();

  constructor(backend: SecretBackend) {
    this.backend = backend;
  }

  private account(providerId: string): string {
    return `provider:${providerId}`;
  }

  private async index(): Promise<string[]> {
    if (this.cachedIndex !== null) return this.cachedIndex;
    try {
      const raw = await this.backend.get(INDEX);
      const ids = raw ? (JSON.parse(raw) as unknown) : [];
      const list = Array.isArray(ids) ? ids.filter((x): x is string => typeof x === "string") : [];
      this.cachedIndex = list;
      return list;
    } catch {
      return [];
    }
  }

  async read(providerId: string): Promise<Credential | undefined> {
    if (this.cache.has(providerId)) return this.cache.get(providerId);
    const raw = await this.backend.get(this.account(providerId));
    if (!raw) {
      this.cache.set(providerId, undefined);
      return undefined;
    }
    try {
      const parsed = JSON.parse(raw) as Credential;
      this.cache.set(providerId, parsed);
      return parsed;
    } catch {
      return undefined;
    }
  }

  async list(): Promise<readonly CredentialInfo[]> {
    const out: CredentialInfo[] = [];
    for (const providerId of await this.index()) {
      const credential = await this.read(providerId);
      if (credential) out.push({ providerId, type: credential.type });
    }
    return out;
  }

  modify(providerId: string, fn: (current: Credential | undefined) => Promise<Credential | undefined>): Promise<Credential | undefined> {
    return this.serial(providerId, async () => {
      const current = await this.read(providerId);
      const next = await fn(current);
      if (next === undefined) return current;
      await this.backend.set(this.account(providerId), JSON.stringify(next));
      this.cache.set(providerId, next);
      await this.serial(INDEX, async () => {
        const ids = await this.index();
        if (!ids.includes(providerId)) {
          const updated = [...ids, providerId];
          await this.backend.set(INDEX, JSON.stringify(updated));
          this.cachedIndex = updated;
        }
      });
      return next;
    });
  }

  delete(providerId: string): Promise<void> {
    return this.serial(providerId, async () => {
      await this.backend.delete(this.account(providerId));
      this.cache.set(providerId, undefined);
      await this.serial(INDEX, async () => {
        const ids = await this.index();
        if (ids.includes(providerId)) {
          const updated = ids.filter((id) => id !== providerId);
          await this.backend.set(INDEX, JSON.stringify(updated));
          this.cachedIndex = updated;
        }
      });
    });
  }
}

export function memorySecrets(): SecretBackend & { entries: Map<string, string> } {
  const entries = new Map<string, string>();
  return {
    entries,
    get: (account) => Promise.resolve(entries.get(account) ?? null),
    set: (account, value) => {
      entries.set(account, value);
      return Promise.resolve();
    },
    delete: (account) => {
      entries.delete(account);
      return Promise.resolve();
    },
  };
}
