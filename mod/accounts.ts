import type { AccountDisconnectCause, AccountProvider, AccountStatus, AccountView, GoogleContactSource, GoogleService } from "../core/frame-types.ts";
import type { MacAccountView } from "../core/frames.ts";
import { Listeners } from "../core/listeners.ts";
import { keyedQueue } from "../core/serial.ts";
import type { SecretBackend } from "../daemon/credentials.ts";
import { readJson, writeJsonAtomic } from "./json-file.ts";

export interface AccountRecord extends AccountView {
  backfill: Record<string, unknown>;
}

export interface NewAccount {
  account_id: string;
  provider: AccountProvider;
  address: string;
  owner_agent_id: string;
  services?: GoogleService[];
  contacts?: GoogleContactSource[];
}

export interface GoogleGrants {
  services: GoogleService[];
  contacts: GoogleContactSource[];
}

export type AccountChange =
  | { kind: "added"; account_id: string }
  | { kind: "moved"; account_id: string; from: string }
  | { kind: "status"; account_id: string }
  | { kind: "signed_in"; account_id: string }
  | { kind: "disconnected"; account_id: string };

export interface AccountsOptions {
  file: string;
  secrets: SecretBackend;
  now?: () => Date;
  agentExists?: (agentId: string) => boolean;
  heldElsewhere?: (accountId: string) => string | null;
}

const INDEX = "accounts";
const PROVIDERS: readonly AccountProvider[] = ["gmail", "slack", "jira"];
const CAUSES: readonly AccountDisconnectCause[] = ["sign_in_again", "admin_blocks", "slack_signed_out", "temporarily_failing"];
export const GOOGLE_SERVICES: readonly GoogleService[] = ["gmail", "drive", "sheets", "docs", "calendar"];
export const GOOGLE_CONTACT_SOURCES: readonly GoogleContactSource[] = ["contacts", "other_contacts", "directory"];

export const contactsOf = (a: Pick<AccountView, "contacts">): GoogleContactSource[] => a.contacts ?? [];

export const servicesOf = (a: Pick<AccountView, "services">): GoogleService[] => a.services ?? ["gmail"];

export function accountIdOf(
  a: { provider: "gmail"; address: string } | { provider: "slack"; team_id: string; user_id: string } | { provider: "jira"; host: string; account_id: string },
): string {
  switch (a.provider) {
    case "gmail":
      return `gmail:${a.address.trim().toLowerCase()}`;
    case "slack":
      return `slack:${a.team_id}:${a.user_id}`;
    case "jira":
      return `jira:${a.host.trim().toLowerCase()}:${a.account_id}`;
  }
}

export const SERVICE_NAME: Record<AccountProvider, string> = { gmail: "Gmail", slack: "Slack", jira: "Jira" };

export function accountLabel(a: Pick<AccountView, "provider" | "address">): string {
  switch (a.provider) {
    case "gmail":
      return a.address;
    case "slack":
    case "jira":
      return `${a.address} (${SERVICE_NAME[a.provider]})`;
  }
}

export function accountView(a: AccountView): AccountView {
  return {
    account_id: a.account_id,
    provider: a.provider,
    address: a.address,
    owner_agent_id: a.owner_agent_id,
    status: a.status,
    connected_at: a.connected_at,
    ...(a.services ? { services: [...a.services] } : {}),
    ...(a.contacts ? { contacts: [...a.contacts] } : {}),
  };
}

const isStatus = (v: unknown): v is AccountStatus =>
  v === "connected" || (typeof v === "object" && v !== null && CAUSES.includes((v as { disconnected?: unknown }).disconnected as AccountDisconnectCause));

function parseView(v: unknown): AccountView | null {
  if (typeof v !== "object" || v === null) return null;
  const r = v as Record<string, unknown>;
  const { account_id: id, provider, address, owner_agent_id: owner, connected_at: at, status } = r;
  if (typeof id !== "string" || !id || typeof address !== "string" || typeof owner !== "string" || !owner || typeof at !== "string") return null;
  if (!PROVIDERS.includes(provider as AccountProvider) || !isStatus(status)) return null;
  const services = Array.isArray(r.services) ? GOOGLE_SERVICES.filter((s) => (r.services as unknown[]).includes(s)) : undefined;
  const contacts = Array.isArray(r.contacts) ? GOOGLE_CONTACT_SOURCES.filter((s) => (r.contacts as unknown[]).includes(s)) : undefined;
  return {
    account_id: id,
    provider: provider as AccountProvider,
    address,
    owner_agent_id: owner,
    status,
    connected_at: at,
    ...(services ? { services } : {}),
    ...(contacts ? { contacts } : {}),
  };
}

function parseRecord(v: unknown): AccountRecord | null {
  const view = parseView(v);
  if (!view) return null;
  const backfill = (v as { backfill?: unknown }).backfill;
  return { ...view, backfill: typeof backfill === "object" && backfill !== null && !Array.isArray(backfill) ? (backfill as Record<string, unknown>) : {} };
}

function listed(accounts: AccountView[]): string {
  const labels = accounts.map(accountLabel);
  return labels.length < 2 ? labels.join("") : `${labels.slice(0, -1).join(", ")} and ${labels.at(-1) ?? ""}`;
}

export class Accounts {
  private readonly opts: AccountsOptions;
  private records: AccountRecord[];
  private readonly listeners = new Listeners<[AccountChange]>();
  private readonly serial = keyedQueue();

  constructor(opts: AccountsOptions) {
    this.opts = opts;
    const raw = readJson(opts.file);
    const list = typeof raw === "object" && raw !== null ? (raw as { accounts?: unknown }).accounts : null;
    this.records = Array.isArray(list) ? list.map(parseRecord).filter((r): r is AccountRecord => r !== null) : [];
  }

  list(): AccountRecord[] {
    return this.records.map((r) => ({ ...r }));
  }

  get(accountId: string): AccountRecord | null {
    const r = this.records.find((a) => a.account_id === accountId);
    return r ? { ...r } : null;
  }

  ownedBy(agentId: string): AccountRecord[] {
    return this.list().filter((a) => a.owner_agent_id === agentId);
  }

  async add(input: NewAccount, secret?: string): Promise<AccountRecord> {
    this.ownerOrThrow(input.owner_agent_id);
    if (!PROVIDERS.includes(input.provider) || !input.account_id.startsWith(`${input.provider}:`)) throw new Error("an account needs its provider's id");
    const label = accountLabel(input);
    if (this.records.some((a) => a.account_id === input.account_id)) throw new Error(`${label} is already connected`);
    const elsewhere = this.opts.heldElsewhere?.(input.account_id);
    if (elsewhere) throw new Error(`${label} is already connected on ${elsewhere}`);
    if (secret !== undefined) await this.setSecret(input.account_id, secret);
    if (this.records.some((a) => a.account_id === input.account_id)) throw new Error(`${label} is already connected`);
    const record: AccountRecord = {
      account_id: input.account_id,
      provider: input.provider,
      address: input.address,
      owner_agent_id: input.owner_agent_id,
      status: "connected",
      connected_at: (this.opts.now?.() ?? new Date()).toISOString(),
      ...(input.services ? { services: [...input.services] } : {}),
      ...(input.contacts ? { contacts: [...input.contacts] } : {}),
      backfill: {},
    };
    this.records = [...this.records, record];
    this.save({ kind: "added", account_id: record.account_id });
    return { ...record };
  }

  moveOwner(accountId: string, ownerAgentId: string): AccountRecord {
    this.ownerOrThrow(ownerAgentId);
    const from = this.need(accountId).owner_agent_id;
    if (from === ownerAgentId) return this.need(accountId);
    const moved = this.change(accountId, { owner_agent_id: ownerAgentId });
    this.save({ kind: "moved", account_id: accountId, from });
    return moved;
  }

  setStatus(accountId: string, status: AccountStatus): AccountRecord {
    const changed = this.change(accountId, { status });
    this.save({ kind: "status", account_id: accountId });
    return changed;
  }

  async signedIn(accountId: string, secret: string, grants: GoogleGrants): Promise<AccountRecord> {
    this.need(accountId);
    await this.setSecret(accountId, secret);
    const changed = this.change(accountId, { status: "connected", services: [...grants.services], contacts: [...grants.contacts] });
    this.save({ kind: "signed_in", account_id: accountId });
    return changed;
  }

  setGrants(accountId: string, grants: GoogleGrants): AccountRecord {
    const changed = this.change(accountId, { services: [...grants.services], contacts: [...grants.contacts] });
    this.save({ kind: "status", account_id: accountId });
    return changed;
  }

  setBackfill(accountId: string, backfill: Record<string, unknown>): AccountRecord {
    const changed = this.change(accountId, { backfill });
    this.save(null);
    return changed;
  }

  async disconnect(accountId: string): Promise<boolean> {
    if (!this.records.some((a) => a.account_id === accountId)) return false;
    await this.deleteSecret(accountId);
    this.records = this.records.filter((a) => a.account_id !== accountId);
    this.save({ kind: "disconnected", account_id: accountId });
    return true;
  }

  getSecret(accountId: string): Promise<string | null> {
    return this.opts.secrets.get(this.secretName(accountId));
  }

  setSecret(accountId: string, value: string): Promise<void> {
    return this.serial(accountId, async () => {
      await this.opts.secrets.set(this.secretName(accountId), value);
      await this.serial(INDEX, async () => {
        const ids = await this.index();
        if (!ids.includes(accountId)) await this.opts.secrets.set(INDEX, JSON.stringify([...ids, accountId]));
      });
    });
  }

  deleteBlocked(agentId: string): string | null {
    const owned = this.ownedBy(agentId);
    if (owned.length === 0) return null;
    const what = owned.length === 1 ? "it" : "each";
    return `this agent owns ${listed(owned)}: move ${what} to another agent or disconnect ${what}, then delete the agent`;
  }

  onChange(listener: (change: AccountChange) => void): () => void {
    return this.listeners.add(listener);
  }

  private ownerOrThrow(agentId: string): void {
    if (!agentId || !(this.opts.agentExists?.(agentId) ?? true)) throw new Error("an account needs an owner: pick the agent it belongs to");
  }

  private need(accountId: string): AccountRecord {
    const r = this.get(accountId);
    if (!r) throw new Error("that account is not connected on this Mac");
    return r;
  }

  private change(accountId: string, patch: Partial<AccountRecord>): AccountRecord {
    const next = { ...this.need(accountId), ...patch };
    this.records = this.records.map((a) => (a.account_id === accountId ? next : a));
    return { ...next };
  }

  private save(change: AccountChange | null): void {
    writeJsonAtomic(this.opts.file, { version: 1, accounts: this.records }, { pretty: true, newline: true, mode: 0o600 });
    if (change) this.listeners.emit(change);
  }

  private secretName(accountId: string): string {
    return `account:${accountId}`;
  }

  private async index(): Promise<string[]> {
    try {
      const raw = await this.opts.secrets.get(INDEX);
      const ids = raw ? (JSON.parse(raw) as unknown) : [];
      return Array.isArray(ids) ? ids.filter((x): x is string => typeof x === "string") : [];
    } catch {
      return [];
    }
  }

  private deleteSecret(accountId: string): Promise<void> {
    return this.serial(accountId, async () => {
      await this.opts.secrets.delete(this.secretName(accountId));
      await this.serial(INDEX, async () => {
        const ids = await this.index();
        if (ids.includes(accountId)) await this.opts.secrets.set(INDEX, JSON.stringify(ids.filter((id) => id !== accountId)));
      });
    });
  }
}

export interface PeerAccountsOptions {
  link: (macId: string) => { request(frame: { type: string } & Record<string, unknown>): Promise<Record<string, unknown>> } | null;
  name: (macId: string) => string;
}

export class PeerAccounts {
  private readonly opts: PeerAccountsOptions;
  private readonly macs = new Map<string, AccountView[]>();

  constructor(opts: PeerAccountsOptions) {
    this.opts = opts;
  }

  async pull(macId: string): Promise<void> {
    const link = this.opts.link(macId);
    if (!link) return;
    let reply: Record<string, unknown>;
    try {
      reply = await link.request({ type: "peer_accounts_get" });
    } catch {
      return;
    }
    if (!Array.isArray(reply.accounts)) return;
    this.macs.set(
      macId,
      reply.accounts.map(parseView).filter((a): a is AccountView => a !== null),
    );
  }

  sync(macIds: string[]): void {
    const keep = new Set(macIds);
    for (const id of [...this.macs.keys()]) if (!keep.has(id)) this.macs.delete(id);
  }

  everywhere(): MacAccountView[] {
    return [...this.macs].flatMap(([mac, accounts]) => accounts.map((a) => ({ ...a, mac_id: mac, mac_name: this.opts.name(mac) })));
  }

  heldBy(accountId: string): string | null {
    for (const [mac, accounts] of this.macs) if (accounts.some((a) => a.account_id === accountId)) return this.opts.name(mac);
    return null;
  }

  deleteBlocked(agentId: string): string | null {
    for (const [mac, accounts] of this.macs) {
      const owned = accounts.filter((a) => a.owner_agent_id === agentId);
      if (owned.length > 0)
        return `this agent owns ${listed(owned)} on ${this.opts.name(mac)}: move or disconnect ${owned.length === 1 ? "it" : "them"} on ${this.opts.name(mac)}, then delete the agent`;
    }
    return null;
  }
}

export function ownedAccount(accounts: Pick<Accounts, "ownedBy">, agentId: string, name: string): AccountRecord | null {
  const wanted = name.trim().toLowerCase();
  if (!wanted) return null;
  return accounts.ownedBy(agentId).find((a) => [a.account_id, a.address, accountLabel(a)].some((n) => n.toLowerCase() === wanted)) ?? null;
}

export function perAccount<T>(
  accounts: Pick<Accounts, "onChange">,
  make: (accountId: string) => T,
  keepThrough: (change: AccountChange) => boolean = () => false,
): (accountId: string) => T {
  const made = new Map<string, T>();
  accounts.onChange((change) => {
    if (!keepThrough(change)) made.delete(change.account_id);
  });
  return (accountId) => {
    const known = made.get(accountId);
    if (known !== undefined) return known;
    const fresh = make(accountId);
    made.set(accountId, fresh);
    return fresh;
  };
}
