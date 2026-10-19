/**
 * A checkout's daemon keeping up with its sources (plan 024): a change to `mod/` or `core/` reloads the mod in place,
 * and a change to `daemon/` or `core/` makes a restart due, which the window offers as a notice with a button. The
 * restart is the person's call: the daemon stops cleanly and the shell's supervisor starts it again. The installed app
 * never watches its files, so no restart is ever due there; it can still be asked for one.
 */

/** What the dev reload is built from: reloading the mod, restarting, whether anything runs, and where to say so. */
export interface DevReloadOptions {
  /** Reload the mod; resolves to what to say about it. */
  reloadMod: () => Promise<string>;
  /** Stop cleanly, to be started again by the shell. */
  restart: (why: string) => void;
  /** Whether no chat has a turn running and no approval waits. */
  idle: () => Promise<boolean>;
  report: (message: string) => void;
}

/** The checkout's reloads and restarts. */
export class DevReload {
  private readonly opts: DevReloadOptions;
  private reloading: Promise<void> | null = null;
  private again = false;
  /** The latest file to ask for a reload, named when it runs. */
  private changed = "";
  /** The latest file whose change made a restart due; null when none is. */
  private due: string | null = null;
  private readonly listeners = new Set<(file: string) => void>();

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

  /** A source the daemon runs changed: a restart is due, and whoever listens hears which file asked for it. */
  daemonChanged(file: string): void {
    const first = this.due === null;
    this.due = file;
    if (first) this.opts.report(`${file} changed: restart loki to use it`);
    for (const fn of this.listeners) fn(file);
  }

  /** The file whose change made a restart due, or null when none is. */
  restartDue(): string | null {
    return this.due;
  }

  /** Hear when a restart becomes due (the file); returns the unsubscribe. */
  onRestartDue(fn: (file: string) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /**
   * Restart now, as the person asked: null once it is under way, else why not. A chat working or an approval waiting
   * would be cut off, so that is refused unless `anyway`.
   */
  async restart(anyway: boolean): Promise<string | null> {
    if (!anyway && !(await this.opts.idle())) return "a chat is still working or waiting for you: restarting now cuts it off";
    this.opts.restart(this.due ? `${this.due} changed` : "asked");
    return null;
  }
}
