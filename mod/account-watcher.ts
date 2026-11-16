import { messageOf } from "../core/errors.ts";
import type { AccountProvider } from "../core/frame-types.ts";
import type { AccountRecord, Accounts } from "./accounts.ts";

export interface AccountSync {
  tick(): Promise<void>;
  stop?(): void;
}

export type AccountSyncFactory = (account: AccountRecord) => AccountSync;

export interface AccountWatcherOptions {
  accounts: Pick<Accounts, "list" | "onChange">;
  factories: Partial<Record<AccountProvider, AccountSyncFactory>>;
  report?: (event: string, detail: unknown) => void;
  intervalMs?: number;
}

const MINUTE = 60_000;

export class AccountWatcher {
  private readonly opts: AccountWatcherOptions;
  private readonly syncs = new Map<string, AccountSync>();
  private readonly running = new Map<string, Promise<void>>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private unsubscribe: (() => void) | null = null;

  constructor(opts: AccountWatcherOptions) {
    this.opts = opts;
  }

  start(): void {
    this.unsubscribe ??= this.opts.accounts.onChange((change) => this.rebuild(change.account_id));
    for (const account of this.opts.accounts.list()) this.syncFor(account);
    void this.tick();
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), this.opts.intervalMs ?? MINUTE);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.unsubscribe?.();
    this.unsubscribe = null;
    for (const id of [...this.syncs.keys()]) this.drop(id);
  }

  async tick(): Promise<void> {
    const started: Array<Promise<void>> = [];
    for (const account of this.opts.accounts.list()) {
      const id = account.account_id;
      if (this.running.has(id) || !watched(account)) continue;
      const sync = this.syncFor(account);
      if (!sync) continue;
      const run = (async () => {
        try {
          await sync.tick();
        } catch (error) {
          this.opts.report?.("account:sync-failed", { account_id: id, error: messageOf(error) });
        } finally {
          this.running.delete(id);
        }
      })();
      this.running.set(id, run);
      started.push(run);
    }
    await Promise.all(started);
  }

  private syncFor(account: AccountRecord): AccountSync | null {
    const known = this.syncs.get(account.account_id);
    if (known) return known;
    const factory = this.opts.factories[account.provider];
    if (!factory) return null;
    try {
      const sync = factory(account);
      this.syncs.set(account.account_id, sync);
      return sync;
    } catch (error) {
      this.opts.report?.("account:sync-failed", { account_id: account.account_id, error: messageOf(error) });
      return null;
    }
  }

  private rebuild(accountId: string): void {
    this.drop(accountId);
    const account = this.opts.accounts.list().find((a) => a.account_id === accountId);
    if (account) this.syncFor(account);
  }

  private drop(accountId: string): void {
    const sync = this.syncs.get(accountId);
    if (!sync) return;
    this.syncs.delete(accountId);
    sync.stop?.();
  }
}

const watched = (account: AccountRecord): boolean => account.status === "connected" || account.status.disconnected === "temporarily_failing";
