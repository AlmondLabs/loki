import { execFile } from "node:child_process";

export interface TreeKillHost {
  platform: NodeJS.Platform;
  run: (command: string, args: string[]) => void;
  signal: (pid: number, signal: NodeJS.Signals) => void;
}

const host: TreeKillHost = {
  platform: process.platform,
  run: (command, args) => {
    execFile(command, args, { windowsHide: true }, () => {});
  },
  signal: (pid, signal) => {
    process.kill(pid, signal);
  },
};

/**
 * End `pid` and everything it started: on Windows its process tree, elsewhere its process group (a child spawned
 * `detached` leads one), or the process alone when it leads none.
 */
export function killTree(pid: number, h: TreeKillHost = host): void {
  if (h.platform === "win32") return h.run("taskkill", ["/PID", String(pid), "/T", "/F"]);
  try {
    h.signal(-pid, "SIGTERM");
  } catch {
    try {
      h.signal(pid, "SIGTERM");
    } catch {}
  }
}
