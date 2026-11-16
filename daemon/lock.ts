import { closeSync, linkSync, openSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: it exists but belongs to someone else, which still means the lock is held.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

const TAKEOVER_STALE_MS = 10_000;
const ATTEMPTS = 50;

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
    } catch {}
  }
}

function held(file: string, pid: number): Lock {
  return {
    release() {
      if (readPid(file) !== pid) return;
      try {
        unlinkSync(file);
      } catch {}
    },
  };
}

export function acquire(file: string, pid = process.pid): Lock | { heldBy: number } {
  const takeover = `${file}.takeover`;
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    if (create(file, pid)) return held(file, pid);
    const holder = readPid(file);
    if (Number.isFinite(holder) && holder !== pid && alive(holder)) return { heldBy: holder };

    let fd: number;
    try {
      fd = openSync(takeover, "wx", 0o600);
    } catch (error) {
      if (code(error) !== "EEXIST") throw error;
      try {
        if (Date.now() - statSync(takeover).mtimeMs > TAKEOVER_STALE_MS) unlinkSync(takeover);
      } catch {}
      pause(20);
      continue;
    }
    try {
      closeSync(fd);
      const now = readPid(file);
      if (Number.isFinite(now) && now !== holder && alive(now)) return { heldBy: now };
      try {
        unlinkSync(file);
      } catch {}
      if (create(file, pid)) return held(file, pid);
    } finally {
      try {
        unlinkSync(takeover);
      } catch {}
    }
  }
  return { heldBy: readPid(file) };
}
