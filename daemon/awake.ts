import { spawn, type ChildProcess } from "node:child_process";

export type Spawner = (command: string, args: string[]) => Pick<ChildProcess, "kill" | "on">;

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

  held(): boolean {
    return this.child !== null;
  }

  set(on: boolean): void {
    if (this.opts.platform !== "darwin") return;
    if (on && !this.child) {
      const child = this.opts.spawn("/usr/bin/caffeinate", ["-s", "-w", String(this.opts.pid)]);
      const gone = () => {
        if (this.child === child) this.child = null;
      };
      child.on("exit", gone);
      // Outside (Node): a spawn that fails (too many processes or open files) is emitted as an error, thrown when nobody listens.
      child.on("error", gone);
      this.child = child;
    } else if (!on && this.child) {
      const child = this.child;
      this.child = null;
      child.kill();
    }
  }
}
