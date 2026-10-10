import type { Credential, CredentialInfo, CredentialStore } from "@earendil-works/pi-ai";

/**
 * Model provider credentials in the system keychain (plan 017, U8, KTD10): one entry per provider under the service
 * "loki", holding pi-ai's credential (an API key, or a sign-in's tokens) as JSON, and an index entry naming the
 * providers that have one, since a keychain cannot be listed. pi-ai refreshes a sign-in's tokens through `modify`,
 * which runs one change at a time per provider, so a refresh and a new sign-in never overwrite each other.
 */

/** Where secrets are kept: the keychain, or a map in tests. */
export interface SecretBackend {
  get(account: string): Promise<string | null>;
  set(account: string, value: string): Promise<void>;
  delete(account: string): Promise<void>;
}

const SERVICE = "loki";
const INDEX = "providers";

/** The system keychain (macOS Keychain, Windows Credential Manager, the Secret Service on Linux). */
export async function keychain(): Promise<SecretBackend> {
  const { Entry } = await import("@napi-rs/keyring");
  return {
    get: (account) => Promise.resolve(new Entry(SERVICE, account).getPassword()),
    set: (account, value) => Promise.resolve(new Entry(SERVICE, account).setPassword(value)),
    delete: async (account) => void new Entry(SERVICE, account).deletePassword(),
  };
}

export class KeychainCredentials implements CredentialStore {
  private readonly backend: SecretBackend;
  /** Each provider's last change, so the next waits for it; the index has a queue of its own, which every provider's change joins. */
  private readonly queue = new Map<string, Promise<unknown>>();

  constructor(backend: SecretBackend) {
    this.backend = backend;
  }

  private account(providerId: string): string {
    return `provider:${providerId}`;
  }

  private async index(): Promise<string[]> {
    try {
      const raw = await this.backend.get(INDEX);
      const ids = raw ? (JSON.parse(raw) as unknown) : [];
      return Array.isArray(ids) ? ids.filter((x): x is string => typeof x === "string") : [];
    } catch {
      return [];
    }
  }

  private serial<T>(providerId: string, work: () => Promise<T>): Promise<T> {
    const run = (this.queue.get(providerId) ?? Promise.resolve()).then(work, work);
    this.queue.set(providerId, run.catch(() => undefined));
    return run;
  }

  async read(providerId: string): Promise<Credential | undefined> {
    const raw = await this.backend.get(this.account(providerId));
    if (!raw) return undefined;
    try {
      return JSON.parse(raw) as Credential;
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
      await this.serial(INDEX, async () => {
        const ids = await this.index();
        if (!ids.includes(providerId)) await this.backend.set(INDEX, JSON.stringify([...ids, providerId]));
      });
      return next;
    });
  }

  delete(providerId: string): Promise<void> {
    return this.serial(providerId, async () => {
      await this.backend.delete(this.account(providerId));
      await this.serial(INDEX, async () => {
        const ids = await this.index();
        if (ids.includes(providerId)) await this.backend.set(INDEX, JSON.stringify(ids.filter((id) => id !== providerId)));
      });
    });
  }
}

/** A map standing in for the keychain, for tests. */
export function memorySecrets(): SecretBackend & { entries: Map<string, string> } {
  const entries = new Map<string, string>();
  return {
    entries,
    get: async (account) => entries.get(account) ?? null,
    set: async (account, value) => void entries.set(account, value),
    delete: async (account) => void entries.delete(account),
  };
}
