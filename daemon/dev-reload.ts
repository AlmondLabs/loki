/**
 * A checkout's daemon keeping up with its sources (plan 024): a change to `mod/` or `core/` reloads the mod in place,
 * and a change to `daemon/` or `core/` restarts the daemon once nothing is running, which the shell's supervisor
 * starts again. The installed app never does this: it does not watch its files.
 */

/** What the dev reload is built from: reloading the mod, restarting, whether anything runs, and a clock. */
export interface DevReloadOptions {
  /** Reload the mod; resolves to what to say about it. */
  reloadMod: () => Promise<string>;
  /** Stop cleanly, to be started again by the shell. */
  restart: (why: string) => void;
  /** Whether no chat has a turn running and no approval waits. */
  idle: () => Promise<boolean>;
  report: (message: string) => void;
  /** How often to look again while something runs (default 5 s). */
  pollMs?: number;
  /** How long to wait for idle before saying a restart is due and stopping to look (default 10 minutes). */
  giveUpMs?: number;
  now?: () => number;
  /** A timer; tests pass their own. */
  later?: (fn: () => void, ms: number) => () => void;
}

const defaultLater = (fn: () => void, ms: number) => {
  const t = setTimeout(fn, ms);
  t.unref();
  return () => clearTimeout(t);
};

/** The checkout's reloads and restarts. */
export class DevReload {
  private readonly opts: DevReloadOptions;
  private reloading: Promise<void> | null = null;
  private again = false;
  /** The latest file to ask for a reload, named when it runs. */
  private changed = "";
  /** The file whose change asks for a restart, and since when; null when none is due. */
  private due: { file: string; since: number } | null = null;
  private cancel: (() => void) | null = null;

  constructor(opts: DevReloadOptions) {
    this.opts = opts;
  }

  /** A source the mod bundles changed: reload it, once more after a reload already under way. */
  modChanged(file: string): Promise<void> {
    this.changed = file;
    if (this.reloading) {
      this.again = true;
      return this.reloading;
    }
    this.reloading = (async () => {
      // A change during the reload sets `again` (read through a call: it changes while the reload awaits).
      do {
        this.again = false;
        const name = this.changed;
        this.opts.report(`mod loki reloaded after ${name} changed: ${await this.opts.reloadMod()}`);
      } while (this.askedAgain());
      this.reloading = null;
    })();
    return this.reloading;
  }

  private askedAgain(): boolean {
    return this.again;
  }

  /** A source the daemon runs changed: restart once nothing is running. */
  daemonChanged(file: string): Promise<void> {
    const now = (this.opts.now ?? Date.now)();
    if (this.due) {
      this.due = { file, since: this.due.since };
      return Promise.resolve();
    }
    this.due = { file, since: now };
    return this.look();
  }

  /** Stop looking (the daemon stops). */
  stop(): void {
    this.cancel?.();
    this.cancel = null;
    this.due = null;
  }

  private async look(): Promise<void> {
    const due = this.due;
    if (!due) return;
    if (await this.opts.idle()) {
      this.due = null;
      this.opts.restart(`${due.file} changed`);
      return;
    }
    const now = (this.opts.now ?? Date.now)();
    if (now - due.since >= (this.opts.giveUpMs ?? 10 * 60_000)) {
      this.due = null;
      this.opts.report(`${due.file} changed, but a chat is still running: restart loki to use it`);
      return;
    }
    this.cancel = (this.opts.later ?? defaultLater)(() => void this.look(), this.opts.pollMs ?? 5000);
  }
}
