import { Listeners } from "../core/listeners.ts";
import type { RestartAnswer } from "../mod/frames/daemon.ts";

export interface DevReloadOptions {
  reloadMod: () => Promise<string>;
  buildPage?: () => Promise<string | null>;
  restart: (why: string) => void;
  idle: () => Promise<boolean>;
  report: (message: string) => void;
}

export class DevReload {
  private readonly opts: DevReloadOptions;
  private reloading: Promise<void> | null = null;
  private again = false;
  private changed = "";
  private due: string | null = null;
  private restartNeeded = false;
  private buildNeeded = false;
  private updating: Promise<RestartAnswer> | null = null;
  private readonly listeners = new Listeners<[file: string]>();

  constructor(opts: DevReloadOptions) {
    this.opts = opts;
  }

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

  daemonChanged(file: string): void {
    this.restartNeeded = true;
    this.makeDue(file);
  }

  pageChanged(file: string): void {
    if (!this.opts.buildPage) return;
    this.buildNeeded = true;
    this.makeDue(file);
  }

  private makeDue(file: string): void {
    const first = this.due === null;
    this.due = file;
    if (first) this.opts.report(`${file} changed: update loki to use it`);
    this.listeners.emit(file);
  }

  restartDue(): string | null {
    return this.due;
  }

  onRestartDue(fn: (file: string) => void): () => void {
    return this.listeners.add(fn);
  }

  restart(anyway: boolean): Promise<RestartAnswer> {
    this.updating ??= this.update(anyway).finally(() => (this.updating = null));
    return this.updating;
  }

  private async update(anyway: boolean): Promise<RestartAnswer> {
    const restart = this.restartNeeded || !this.buildNeeded;
    if (restart && !anyway && !(await this.opts.idle()))
      return { code: "not_updated", reason: "a chat is still working or waiting for you: updating now cuts it off" };
    const why = this.due ? `${this.due} changed` : "asked";
    if (this.buildNeeded && this.opts.buildPage) {
      this.buildNeeded = false;
      const failed = await this.opts.buildPage();
      if (failed) {
        this.buildNeeded = true;
        return { code: "not_updated", reason: `the page did not build:\n${failed}` };
      }
      this.opts.report("page built: the window reloads on it");
    }
    if (!restart) {
      if (!this.buildNeeded && !this.restartNeeded) this.due = null;
      return { code: "updated" };
    }
    return { code: "restart", restart: () => this.opts.restart(why) };
  }
}
