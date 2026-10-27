/**
 * A checkout's daemon keeping up with its sources (plans 024 and 041): a change to `mod/` or `core/` reloads the mod in
 * place, and a change to `daemon/` or `core/` makes a restart due. Under `npm start` the window runs the built page, so
 * a change to `app/` or `core/` makes a page build due too. The window offers what is due as one notice with **update**,
 * and the update is the person's call: the page is built, then the daemon stops cleanly and the shell's supervisor
 * starts it again. The installed app never watches its files, so nothing is ever due there; it can still be asked for a
 * restart.
 */

/** What the dev reload is built from: reloading the mod, building the page, restarting, whether anything runs, and where to say so. */
export interface DevReloadOptions {
  /** Reload the mod; resolves to what to say about it. */
  reloadMod: () => Promise<string>;
  /** Build the page the window runs: null once built, else what went wrong. Absent when the window runs Vite. */
  buildPage?: () => Promise<string | null>;
  /** Stop cleanly, to be started again by the shell. */
  restart: (why: string) => void;
  /** Whether no chat has a turn running and no approval waits. */
  idle: () => Promise<boolean>;
  report: (message: string) => void;
}

/** The checkout's reloads, builds and restarts. */
export class DevReload {
  private readonly opts: DevReloadOptions;
  private reloading: Promise<void> | null = null;
  private again = false;
  /** The latest file to ask for a reload, named when it runs. */
  private changed = "";
  /** The latest file whose change made an update due; null when none is. */
  private due: string | null = null;
  /** Whether the due update restarts the daemon, and whether it builds the page. */
  private restartNeeded = false;
  private buildNeeded = false;
  private updating: Promise<string | null> | null = null;
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
    this.restartNeeded = true;
    this.makeDue(file);
  }

  /** A source of the page changed: a build is due when the window runs the built page; Vite's hot reload has it otherwise. */
  pageChanged(file: string): void {
    if (!this.opts.buildPage) return;
    this.buildNeeded = true;
    this.makeDue(file);
  }

  private makeDue(file: string): void {
    const first = this.due === null;
    this.due = file;
    if (first) this.opts.report(`${file} changed: update loki to use it`);
    for (const fn of this.listeners) fn(file);
  }

  /** The file whose change made an update due, or null when none is. */
  restartDue(): string | null {
    return this.due;
  }

  /** Hear when an update becomes due (the file); returns the unsubscribe. */
  onRestartDue(fn: (file: string) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /**
   * Update now, as the person asked: build the page if that is due, then restart if that is due (or if nothing is: the
   * installed app's restart). Null once done or under way, else why not. A restart would cut off a chat that is working
   * or an approval that waits, so that is refused unless `anyway`; a build alone cuts nothing off.
   */
  restart(anyway: boolean): Promise<string | null> {
    this.updating ??= this.update(anyway).finally(() => (this.updating = null));
    return this.updating;
  }

  private async update(anyway: boolean): Promise<string | null> {
    const restart = this.restartNeeded || !this.buildNeeded;
    if (restart && !anyway && !(await this.opts.idle())) return "a chat is still working or waiting for you: updating now cuts it off";
    const why = this.due ? `${this.due} changed` : "asked";
    if (this.buildNeeded && this.opts.buildPage) {
      this.buildNeeded = false; // a change while it builds asks for another build
      const failed = await this.opts.buildPage();
      if (failed) {
        this.buildNeeded = true;
        return `the page did not build:\n${failed}`;
      }
      this.opts.report("page built: the window reloads on it");
    }
    if (!restart) {
      // Still due when something changed while it built; the window, reloading on the build, hears it again.
      if (!this.buildNeeded && !this.restartNeeded) this.due = null;
      return null;
    }
    this.opts.restart(why);
    return null;
  }
}
