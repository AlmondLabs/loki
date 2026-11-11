import type { AccountDisconnectCause, AccountProvider, AccountStatus, AccountView, GoogleService } from "../core/frame-types.ts";
import type { MacAccountView } from "../core/frames.ts";
import { Listeners } from "../core/listeners.ts";
import { keyedQueue } from "../core/serial.ts";
import type { SecretBackend } from "../daemon/credentials.ts";
import { readJson, writeJsonAtomic } from "./json-file.ts";

/**
 * The Gmail mailboxes, Slack workspaces and Jira sites connected on this Mac (plan 067, U2, KTD2, KTD14). Each has exactly one
 * owning agent, which gets its hand-offs and its tools. The records live in `state/accounts.json`; what an account
 * signs in with lives in the keychain under `account:<account_id>`, with an index entry naming those accounts, since a
 * keychain cannot be listed. Agents can read files under ~/.loki, so no token ever goes in the state file.
 *
 * An account lives on one Mac. Paired Macs report the accounts they hold (`peer_accounts_get`, kept in PeerAccounts),
 * so this Mac refuses to connect one twice and refuses to delete an agent whose accounts live on another Mac.
 */

/** One account as the state file keeps it: what the app sees, and the backfill cursor the watcher keeps for itself. */
export interface AccountRecord extends AccountView {
  /** Where the watcher's batches of older items stand (KTD13); its shape is the watcher's, opaque here. */
  backfill: Record<string, unknown>;
}

/** What connecting an account takes: its id (accountIdOf), its service, the address it shows, and its owner. */
export interface NewAccount {
  account_id: string;
  provider: AccountProvider;
  address: string;
  owner_agent_id: string;
  /** A Google account's granted services (AccountView.services). */
  services?: GoogleService[];
}

/** What changed about an account, for the parts that follow its owner: the tools (U9) and reply proposals (U10). */
export type AccountChange =
  | { kind: "added"; account_id: string }
  | { kind: "moved"; account_id: string; from: string }
  | { kind: "status"; account_id: string }
  /** The account signed in again: new tokens, maybe more services, so whatever holds the old tokens drops them. */
  | { kind: "signed_in"; account_id: string }
  | { kind: "disconnected"; account_id: string };

/** What Accounts is built from; the clock, the keychain and the lookups are injected so tests own them. */
export interface AccountsOptions {
  /** `state/accounts.json`. */
  file: string;
  secrets: SecretBackend;
  now?: () => Date;
  /** Whether an agent exists, so an account never gets an owner that is not there; any id is taken when left out. */
  agentExists?: (agentId: string) => boolean;
  /** The name of the paired Mac that already holds an account, or null (PeerAccounts.heldBy). */
  heldElsewhere?: (accountId: string) => string | null;
}

/** The keychain entry naming every account with a secret there. */
const INDEX = "accounts";
const PROVIDERS: readonly AccountProvider[] = ["gmail", "slack", "jira"];
const CAUSES: readonly AccountDisconnectCause[] = ["sign_in_again", "admin_blocks", "slack_signed_out", "temporarily_failing"];
/** Every Google service loki asks for, in the order the app lists them. */
export const GOOGLE_SERVICES: readonly GoogleService[] = ["gmail", "drive", "sheets", "docs", "calendar"];

/** A Google account's services: what its sign-in granted, or Gmail alone for an account signed in before loki asked for more. */
export const servicesOf = (a: Pick<AccountView, "services">): GoogleService[] => a.services ?? ["gmail"];

/**
 * An account's id: the provider and the id it keeps across sign-ins (KTD14). A mailbox is its address, in lower case
 * since Gmail ignores case; a Slack workspace is its team and the person's user in it; a Jira site is the host its API
 * answers on, in lower case as host names are, and the person's Atlassian account id.
 */
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

/** Each service by the name the person knows it by, for messages that name where something is or failed. */
export const SERVICE_NAME: Record<AccountProvider, string> = { gmail: "Gmail", slack: "Slack", jira: "Jira" };

/**
 * An account as the person reads it in a message: a mailbox by its address, a workspace by its name and "(Slack)", a
 * Jira site by its host and "(Jira)".
 */
export function accountLabel(a: Pick<AccountView, "provider" | "address">): string {
  switch (a.provider) {
    case "gmail":
      return a.address;
    case "slack":
    case "jira":
      return `${a.address} (${SERVICE_NAME[a.provider]})`;
  }
}

/** An account as the frames send it: everything but the watcher's cursor. */
export function accountView(a: AccountView): AccountView {
  return {
    account_id: a.account_id,
    provider: a.provider,
    address: a.address,
    owner_agent_id: a.owner_agent_id,
    status: a.status,
    connected_at: a.connected_at,
    ...(a.services ? { services: [...a.services] } : {}),
  };
}

const isStatus = (v: unknown): v is AccountStatus =>
  v === "connected" || (typeof v === "object" && v !== null && CAUSES.includes((v as { disconnected?: unknown }).disconnected as AccountDisconnectCause));

/** An account as a file or another Mac gives it, or null when it is not one: a person or a crash may leave anything. */
function parseView(v: unknown): AccountView | null {
  if (typeof v !== "object" || v === null) return null;
  const r = v as Record<string, unknown>;
  const { account_id: id, provider, address, owner_agent_id: owner, connected_at: at, status } = r;
  if (typeof id !== "string" || !id || typeof address !== "string" || typeof owner !== "string" || !owner || typeof at !== "string") return null;
  if (!PROVIDERS.includes(provider as AccountProvider) || !isStatus(status)) return null;
  const services = Array.isArray(r.services) ? GOOGLE_SERVICES.filter((s) => (r.services as unknown[]).includes(s)) : undefined;
  return { account_id: id, provider: provider as AccountProvider, address, owner_agent_id: owner, status, connected_at: at, ...(services ? { services } : {}) };
}

function parseRecord(v: unknown): AccountRecord | null {
  const view = parseView(v);
  if (!view) return null;
  const backfill = (v as { backfill?: unknown }).backfill;
  return { ...view, backfill: typeof backfill === "object" && backfill !== null && !Array.isArray(backfill) ? (backfill as Record<string, unknown>) : {} };
}

/** The labels of accounts, joined for a sentence: "a", "a and b", "a, b and c". */
function listed(accounts: AccountView[]): string {
  const labels = accounts.map(accountLabel);
  return labels.length < 2 ? labels.join("") : `${labels.slice(0, -1).join(", ")} and ${labels.at(-1) ?? ""}`;
}

/** The accounts connected on this Mac, read from their file at start and written whole after every change. */
export class Accounts {
  private readonly opts: AccountsOptions;
  private records: AccountRecord[];
  private readonly listeners = new Listeners<[AccountChange]>();
  /** One keychain change at a time per account; the index has a queue of its own, which each change joins. */
  private readonly serial = keyedQueue();

  constructor(opts: AccountsOptions) {
    this.opts = opts;
    const raw = readJson(opts.file);
    const list = typeof raw === "object" && raw !== null ? (raw as { accounts?: unknown }).accounts : null;
    this.records = Array.isArray(list) ? list.map(parseRecord).filter((r): r is AccountRecord => r !== null) : [];
  }

  /** Every account here, in the order they were connected. */
  list(): AccountRecord[] {
    return this.records.map((r) => ({ ...r }));
  }

  /** One account, or null when it is not connected here. */
  get(accountId: string): AccountRecord | null {
    const r = this.records.find((a) => a.account_id === accountId);
    return r ? { ...r } : null;
  }

  /** The accounts an agent owns here. */
  ownedBy(agentId: string): AccountRecord[] {
    return this.list().filter((a) => a.owner_agent_id === agentId);
  }

  /**
   * Connect an account with its owner (R2), its secret written to the keychain first so a record never stands without
   * the sign-in it was connected with. Refused without an owner that exists, and when this Mac or a paired one already
   * has the account (KTD14).
   */
  async add(input: NewAccount, secret?: string): Promise<AccountRecord> {
    this.ownerOrThrow(input.owner_agent_id);
    if (!PROVIDERS.includes(input.provider) || !input.account_id.startsWith(`${input.provider}:`)) throw new Error("an account needs its provider's id");
    const label = accountLabel(input);
    if (this.records.some((a) => a.account_id === input.account_id)) throw new Error(`${label} is already connected`);
    const elsewhere = this.opts.heldElsewhere?.(input.account_id);
    if (elsewhere) throw new Error(`${label} is already connected on ${elsewhere}`);
    if (secret !== undefined) await this.setSecret(input.account_id, secret);
    // A second sign-in of the same account may have finished while the keychain was written (two tabs, a double click).
    if (this.records.some((a) => a.account_id === input.account_id)) throw new Error(`${label} is already connected`);
    const record: AccountRecord = {
      account_id: input.account_id,
      provider: input.provider,
      address: input.address,
      owner_agent_id: input.owner_agent_id,
      status: "connected",
      connected_at: (this.opts.now?.() ?? new Date()).toISOString(),
      ...(input.services ? { services: [...input.services] } : {}),
      backfill: {},
    };
    this.records = [...this.records, record];
    this.save({ kind: "added", account_id: record.account_id });
    return { ...record };
  }

  /** Give an account to another agent (R3); its records, cursor and secret stay as they are. */
  moveOwner(accountId: string, ownerAgentId: string): AccountRecord {
    this.ownerOrThrow(ownerAgentId);
    const from = this.need(accountId).owner_agent_id;
    if (from === ownerAgentId) return this.need(accountId);
    const moved = this.change(accountId, { owner_agent_id: ownerAgentId });
    this.save({ kind: "moved", account_id: accountId, from });
    return moved;
  }

  /** Mark an account connected again, or disconnected with why (R22). */
  setStatus(accountId: string, status: AccountStatus): AccountRecord {
    const changed = this.change(accountId, { status });
    this.save({ kind: "status", account_id: accountId });
    return changed;
  }

  /**
   * An account here signed in again (plan 2026-11-11 scripts, R18): its new secret kept, its services as granted now,
   * and connected; owner, cursor and cards stay. Everyone holding the old tokens hears `signed_in` and reads the new.
   */
  async signedIn(accountId: string, secret: string, services: GoogleService[]): Promise<AccountRecord> {
    this.need(accountId);
    await this.setSecret(accountId, secret);
    const changed = this.change(accountId, { status: "connected", services: [...services] });
    this.save({ kind: "signed_in", account_id: accountId });
    return changed;
  }

  /** Keep a Google account's services as a token refresh reports them; the app's row follows. */
  setServices(accountId: string, services: GoogleService[]): AccountRecord {
    const changed = this.change(accountId, { services: [...services] });
    this.save({ kind: "status", account_id: accountId });
    return changed;
  }

  /** Keep the watcher's backfill cursor (KTD13); no one is told, since nothing the person sees changed. */
  setBackfill(accountId: string, backfill: Record<string, unknown>): AccountRecord {
    const changed = this.change(accountId, { backfill });
    this.save(null);
    return changed;
  }

  /** Forget an account and its secret here; false when it was not connected. */
  async disconnect(accountId: string): Promise<boolean> {
    if (!this.records.some((a) => a.account_id === accountId)) return false;
    await this.deleteSecret(accountId);
    this.records = this.records.filter((a) => a.account_id !== accountId);
    this.save({ kind: "disconnected", account_id: accountId });
    return true;
  }

  /** What an account signs in with, from the keychain, or null when it keeps none. */
  getSecret(accountId: string): Promise<string | null> {
    return this.opts.secrets.get(this.secretName(accountId));
  }

  /** Keep what an account signs in with in the keychain, and name the account in the index. */
  setSecret(accountId: string, value: string): Promise<void> {
    return this.serial(accountId, async () => {
      await this.opts.secrets.set(this.secretName(accountId), value);
      await this.serial(INDEX, async () => {
        const ids = await this.index();
        if (!ids.includes(accountId)) await this.opts.secrets.set(INDEX, JSON.stringify([...ids, accountId]));
      });
    });
  }

  /**
   * Why an agent may not be deleted: it owns accounts here, each to be moved or disconnected first (R4, AE5); null when
   * it owns none. On this Mac the app offers that choice; anywhere else the message names the accounts.
   */
  deleteBlocked(agentId: string): string | null {
    const owned = this.ownedBy(agentId);
    if (owned.length === 0) return null;
    const what = owned.length === 1 ? "it" : "each";
    return `this agent owns ${listed(owned)}: move ${what} to another agent or disconnect ${what}, then delete the agent`;
  }

  /** Hear every change to the accounts; returns the unsubscribe. */
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

  /** Write the file whole (owner-only, like every file beside a sign-in), then tell the listeners. */
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

/** What PeerAccounts is built from: a way to ask a paired Mac, and its name as this Mac shows it. */
export interface PeerAccountsOptions {
  link: (macId: string) => { request(frame: { type: string } & Record<string, unknown>): Promise<Record<string, unknown>> } | null;
  name: (macId: string) => string;
}

/**
 * The accounts each paired Mac holds, as it last answered `peer_accounts_get` (KTD14): asked when its link opens and
 * when it pushes `accounts_changed`. A Mac out of reach keeps its last answer, so an agent whose accounts live there
 * still cannot be deleted here; an unpaired Mac's answer goes.
 */
export class PeerAccounts {
  private readonly opts: PeerAccountsOptions;
  private readonly macs = new Map<string, AccountView[]>();

  constructor(opts: PeerAccountsOptions) {
    this.opts = opts;
  }

  /** Ask a Mac for its accounts; out of reach, or on a loki from before accounts, what is kept stays. */
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

  /** Keep only the Macs still paired. */
  sync(macIds: string[]): void {
    const keep = new Set(macIds);
    for (const id of [...this.macs.keys()]) if (!keep.has(id)) this.macs.delete(id);
  }

  /** Every paired Mac's accounts as each last said, marked with the Mac they live on (plan 087, KTD9). */
  everywhere(): MacAccountView[] {
    return [...this.macs].flatMap(([mac, accounts]) => accounts.map((a) => ({ ...a, mac_id: mac, mac_name: this.opts.name(mac) })));
  }

  /** The name of the paired Mac holding an account, or null. */
  heldBy(accountId: string): string | null {
    for (const [mac, accounts] of this.macs) if (accounts.some((a) => a.account_id === accountId)) return this.opts.name(mac);
    return null;
  }

  /** Why an agent may not be deleted here: a paired Mac holds accounts it owns, to be moved or disconnected there. */
  deleteBlocked(agentId: string): string | null {
    for (const [mac, accounts] of this.macs) {
      const owned = accounts.filter((a) => a.owner_agent_id === agentId);
      if (owned.length > 0)
        return `this agent owns ${listed(owned)} on ${this.opts.name(mac)}: move or disconnect ${owned.length === 1 ? "it" : "them"} on ${this.opts.name(mac)}, then delete the agent`;
    }
    return null;
  }
}
