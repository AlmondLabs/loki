import { spawn, type ChildProcess } from "node:child_process";

/**
 * A paired Mac kept from idle sleep while loki runs (plan 023, U11, KTD13, R14), so a chat that lives on it can be
 * reached from the other Mac: `caffeinate -s -w <pid>`, which holds off sleep on power only, lets a closed lid sleep,
 * changes no setting, and ends by itself when the process it watches does. macOS only; elsewhere nothing runs.
 */

/** Starts a child process; tests pass a recorder. */
export type Spawner = (command: string, args: string[]) => Pick<ChildProcess, "kill" | "on">;

/** The sleep assertion, held while asked for. */
export class Awake {
  private child: Pick<ChildProcess, "kill" | "on"> | null = null;
  private readonly opts: { spawn: Spawner; platform: NodeJS.Platform; pid: number };

  constructor(opts: Partial<{ spawn: Spawner; platform: NodeJS.Platform; pid: number }> = {}) {
    this.opts = {
      spawn: opts.spawn ?? ((command, args) => spawn(command, args, { stdio: "ignore" })),
      platform: opts.platform ?? process.platform,
      pid: opts.pid ?? process.pid,
    };
  }

  /** Whether the assertion is held now. */
  held(): boolean {
    return this.child !== null;
  }

  /** Hold the assertion (a Mac is paired) or let it go (none is). */
  set(on: boolean): void {
    if (this.opts.platform !== "darwin") return;
    if (on && !this.child) {
      const child = this.opts.spawn("/usr/bin/caffeinate", ["-s", "-w", String(this.opts.pid)]);
      const gone = () => {
        if (this.child === child) this.child = null;
      };
      child.on("exit", gone);
      // A spawn that fails (too many processes or open files) is emitted as an error, thrown when nobody listens.
      child.on("error", gone);
      this.child = child;
    } else if (!on && this.child) {
      const child = this.child;
      this.child = null;
      child.kill();
    }
  }
}
