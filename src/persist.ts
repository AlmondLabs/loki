import { mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { DeskStore, DeskState } from "./store.js";

const SNAPSHOT_DEBOUNCE_MS = 200;

export function snapshotPath(): string {
  return join(homedir(), ".letta", "loci", "state", "desk.json");
}

/** Load a snapshot into the store's scope. Corrupt/missing files → false. */
export function loadSnapshot(store: DeskStore, path = snapshotPath()): boolean {
  try {
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw) as DeskState;
    if (typeof parsed !== "object" || parsed === null || typeof parsed.widgets !== "object") {
      return false;
    }
    const desk = store.get();
    desk.widgets = parsed.widgets;
    desk.rev = typeof parsed.rev === "number" ? parsed.rev : 0;
    return true;
  } catch {
    return false;
  }
}

/**
 * Persist the desk on every mutation, debounced. Atomic write (tmp + rename)
 * so a crash mid-write can't corrupt the snapshot. Returns an unsubscribe.
 */
export function persistOnChange(store: DeskStore, path = snapshotPath()): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;

  const flush = () => {
    timer = null;
    try {
      mkdirSync(dirname(path), { recursive: true });
      const tmp = `${path}.tmp`;
      writeFileSync(tmp, JSON.stringify(store.get(), null, 2));
      renameSync(tmp, path);
    } catch {
      // Snapshot failures must never break the desk; next patch retries.
    }
  };

  const unsubscribe = store.subscribe(() => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(flush, SNAPSHOT_DEBOUNCE_MS);
  });

  return () => {
    if (timer) {
      clearTimeout(timer);
      flush();
    }
    unsubscribe();
  };
}
