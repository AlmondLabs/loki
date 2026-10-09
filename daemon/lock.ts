import { closeSync, openSync, readFileSync, unlinkSync, writeSync } from "node:fs";

/**
 * One daemon per loki folder (plan 017, KTD18). pi-durable has no lock of its own, and two daemons on one store would
 * run the same tool calls twice. The lock is a file holding the owner's pid, created exclusively; a file whose pid
 * is gone is a crash's leftover and is taken over.
 */

/** Whether a process with this pid is running. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: it exists but belongs to someone else, which still means the lock is held.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export type Lock = { release(): void };

/** Take the lock at `file`, or return the pid that holds it. */
export function acquire(file: string, pid = process.pid): Lock | { heldBy: number } {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(file, "wx", 0o600);
      writeSync(fd, String(pid));
      closeSync(fd);
      return {
        release() {
          try {
            if (Number(readFileSync(file, "utf8")) === pid) unlinkSync(file);
          } catch {
            // already gone
          }
        },
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const holder = Number.parseInt(readFileSync(file, "utf8"), 10);
    if (Number.isFinite(holder) && holder !== pid && alive(holder)) return { heldBy: holder };
    // Its owner is gone (or the file is garbage): take it over once.
    try {
      unlinkSync(file);
    } catch {
      // someone else took it over first; the next attempt sees theirs
    }
  }
  const holder = Number.parseInt(readFileSync(file, "utf8"), 10);
  return { heldBy: holder };
}
