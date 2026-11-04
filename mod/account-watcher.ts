import { messageOf } from "../core/errors.ts";
import type { AccountProvider } from "../core/frame-types.ts";
import type { AccountRecord, Accounts } from "./accounts.ts";

/**
 * The one watcher over every connected account (plan 067, U5, KTD3): it ticks at start and then once a minute, and on
 * each tick runs every account's sync on its own, so a slow or failing account never holds up the others. Each
 * account has one sync, built by its provider's factory and built again whenever the account changes; an account
 * disconnected for a reason only the person can mend (a sign-in, an admin, Slack signed out) is left alone until it
 * is connected again, while one that is only failing for now keeps being tried.
 */

/** What watches one account: a tick reads what changed out there into its threads; it throws why when it could not. */
export interface AccountSync {
  tick(): Promise<void>;
  /** Called when the account changed or went, before the sync is dropped. */
  stop?(): void;
}

/** Builds the sync for one account of a provider. */
export type AccountSyncFactory = (account: AccountRecord) => AccountSync;

/** What AccountWatcher is built from. */
export interface AccountWatcherOptions {
  accounts: Pick<Accounts, "list" | "onChange">;
  /** A provider without a factory is not watched. */
  factories: Partial<Record<AccountProvider, AccountSyncFactory>>;
  /** Where a failed tick is told (mod/log.ts in the mod). */
  report?: (event: string, detail: unknown) => void;
  /** Default a minute. */
  intervalMs?: number;
}

const MINUTE = 60_000;

/** Every connected account's sync, ticked together. */
export class AccountWatcher {
  private readonly opts: AccountWatcherOptions;
  private readonly syncs = new Map<string, AccountSync>();
  /** The tick under way for each account, by account id, so a tick never overlaps the last one of the same account. */
  private readonly running = new Map<string, Promise<void>>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private unsubscribe: (() => void) | null = null;

  constructor(opts: AccountWatcherOptions) {
    this.opts = opts;
  }

  /**
   * Build every account's sync, tick now and then once a minute; an account change from here on builds its sync again
   * at once, since a sync may also be what archives its account's cards (Slack's does).
   */
  start(): void {
    this.unsubscribe ??= this.opts.accounts.onChange((change) => this.rebuild(change.account_id));
    for (const account of this.opts.accounts.list()) this.syncFor(account);
    void this.tick();
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), this.opts.intervalMs ?? MINUTE);
    this.timer.unref();
  }

  /** Stop ticking and stop every sync. */
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.unsubscribe?.();
    this.unsubscribe = null;
    for (const id of [...this.syncs.keys()]) this.drop(id);
  }

  /**
   * Run every watched account's sync once, each apart from the others; an account whose last tick is still running is
   * skipped this time. Resolves when every tick started here has ended; it never rejects.
   */
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

  /** Build an account's sync again from the account as it now stands; an account gone is only stopped. */
  private rebuild(accountId: string): void {
    this.drop(accountId);
    const account = this.opts.accounts.list().find((a) => a.account_id === accountId);
    if (account) this.syncFor(account);
  }

  /** Stop an account's sync and forget it. */
  private drop(accountId: string): void {
    const sync = this.syncs.get(accountId);
    if (!sync) return;
    this.syncs.delete(accountId);
    sync.stop?.();
  }
}

/** Whether an account is watched: connected, or failing only for now, which the next good tick mends. */
const watched = (account: AccountRecord): boolean => account.status === "connected" || account.status.disconnected === "temporarily_failing";
