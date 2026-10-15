import { closeSync, linkSync, openSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";

/**
 * One daemon per loki folder (plan 017, KTD18). pi-durable has no lock of its own, and two daemons on one store would
 * run the same tool calls twice. The lock is a file holding the owner's pid; a file whose pid is gone is a crash's
 * leftover and is taken over.
 *
 * Two daemons starting at once must not both win. The file appears with its pid already in it (written beside it,
 * then linked into place, which fails if it exists), so no one reads it empty and calls it garbage. And a leftover is
 * taken over by one taker at a time (`<lock>.takeover`, made exclusively): otherwise two that both found it stale
 * would each remove it, the second removing the first's fresh lock, and both would serve.
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

/** A takeover older than this was left by a taker that died mid-way. */
const TAKEOVER_STALE_MS = 10_000;
const ATTEMPTS = 50;

/** A lock this process holds; `release` removes the file only while it still names this process. */
export interface Lock {
  release(): void;
}

const code = (error: unknown) => (error as NodeJS.ErrnoException).code;
const readPid = (file: string): number => {
  try {
    return Number.parseInt(readFileSync(file, "utf8"), 10);
  } catch {
    return Number.NaN;
  }
};
const pause = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** Create `file` holding `pid`, all at once; false when it exists. */
function create(file: string, pid: number): boolean {
  const temp = `${file}.${pid}.${process.hrtime.bigint()}`;
  writeFileSync(temp, String(pid), { mode: 0o600 });
  try {
    linkSync(temp, file);
    return true;
  } catch (error) {
    if (code(error) === "EEXIST") return false;
    throw error;
  } finally {
    try {
      unlinkSync(temp);
    } catch {
      // gone already
    }
  }
}

/** The lock as its holder has it: released only while it is still ours. */
function held(file: string, pid: number): Lock {
  return {
    release() {
      if (readPid(file) !== pid) return; // someone else's now
      try {
        unlinkSync(file);
      } catch {
        // already gone
      }
    },
  };
}

/** Take the lock at `file`, or return the pid that holds it. */
export function acquire(file: string, pid = process.pid): Lock | { heldBy: number } {
  const takeover = `${file}.takeover`;
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    if (create(file, pid)) return held(file, pid);
    const holder = readPid(file);
    if (Number.isFinite(holder) && holder !== pid && alive(holder)) return { heldBy: holder };

    // Its owner is gone (or the file is garbage): take it over, alone.
    let fd: number;
    try {
      fd = openSync(takeover, "wx", 0o600);
    } catch (error) {
      if (code(error) !== "EEXIST") throw error;
      try {
        if (Date.now() - statSync(takeover).mtimeMs > TAKEOVER_STALE_MS) unlinkSync(takeover);
      } catch {
        // its taker just finished
      }
      pause(20);
      continue;
    }
    try {
      closeSync(fd);
      // Still the leftover we judged? A taker before us may have replaced it with a live lock.
      const now = readPid(file);
      if (Number.isFinite(now) && now !== holder && alive(now)) return { heldBy: now };
      try {
        unlinkSync(file);
      } catch {
        // gone already
      }
      if (create(file, pid)) return held(file, pid);
    } finally {
      try {
        unlinkSync(takeover);
      } catch {
        // gone already
      }
    }
  }
  return { heldBy: readPid(file) };
}
