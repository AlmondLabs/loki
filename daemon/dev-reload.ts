import { Listeners } from "../core/listeners.ts";
import type { RestartAnswer } from "../mod/frames/daemon.ts";
import type { Report } from "./report.ts";

export const MOD_SETTLE_MS = 300;

export interface DevReloadOptions {
  settleMs?: number;
  reloadMod: () => Promise<string>;
  buildPage?: () => Promise<string | null>;
  restart: (why: string) => void;
  idle: () => Promise<boolean>;
  report: Report;
}

export class DevReload {
  private readonly opts: DevReloadOptions;
  private reloading: Promise<void> | null = null;
  private again = false;
  private changed = "";
  private changedWhileSettling: (() => void) | null = null;
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
    this.changedWhileSettling?.();
    if (this.reloading) {
      this.again = true;
      return this.reloading;
    }
    this.reloading = (async () => {
      // Outside (TypeScript): it narrows `again` to false after the assignment, though a change sets it while the reload
      // awaits, so the loop reads it through a call.
      do {
        await this.settled();
        this.again = false;
        const name = this.changed;
        const result = await this.opts.reloadMod();
        this.opts.report(`mod loki reloaded after ${name} changed: ${result}`, result === "ok" ? "info" : "error");
      } while (this.askedAgain());
      this.reloading = null;
    })();
    return this.reloading;
  }

  private settled(): Promise<void> {
    const ms = this.opts.settleMs ?? MOD_SETTLE_MS;
    return new Promise((resolve) => {
      const done = () => {
        this.changedWhileSettling = null;
        resolve();
      };
      let timer = setTimeout(done, ms);
      this.changedWhileSettling = () => {
        clearTimeout(timer);
        timer = setTimeout(done, ms);
      };
    });
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
    if (first) this.opts.report(`${file} changed: update loki to use it`, "info");
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
      this.opts.report("page built: the window reloads on it", "info");
    }
    if (!restart) {
      if (!this.buildNeeded && !this.restartNeeded) this.due = null;
      return { code: "updated" };
    }
    return { code: "restart", restart: () => this.opts.restart(why) };
  }
}
