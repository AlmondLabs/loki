import { mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DeskState, Scope } from "../packages/core/src/desk-core.ts";
import type { DeskStore } from "./desk-store.ts";

const DEBOUNCE_MS = 200;

function isDeskState(v: unknown): v is DeskState {
  return (
    typeof v === "object" &&
    v !== null &&
    typeof (v as DeskState).scope === "string" &&
    typeof (v as DeskState).layout === "object" &&
    typeof (v as DeskState).overlay === "object"
  );
}

/** Load every <dir>/<scope>.json into the store. Corrupt files are skipped. Returns scopes loaded. */
export function loadDesks(store: DeskStore, dir: string): Scope[] {
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
  const loaded: Scope[] = [];
  for (const f of files) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(join(dir, f), "utf8"));
      if (isDeskState(parsed)) {
        store.load({ ...parsed, rev: typeof parsed.rev === "number" ? parsed.rev : 0 });
        loaded.push(parsed.scope);
      }
    } catch {
      // skip
    }
  }
  return loaded;
}

/**
 * Persist desks on change, debounced per scope, atomic write. A desk with no
 * layout and no overlay is never written — desks exist lazily.
 */
export function persistDesks(store: DeskStore, dir: string, debounceMs = DEBOUNCE_MS): () => void {
  const timers = new Map<Scope, ReturnType<typeof setTimeout>>();

  const flush = (scope: Scope) => {
    timers.delete(scope);
    const state = store.get(scope);
    if (Object.keys(state.layout).length === 0 && Object.keys(state.overlay).length === 0) return;
    try {
      mkdirSync(dir, { recursive: true });
      const path = join(dir, `${scope}.json`);
      writeFileSync(`${path}.tmp`, JSON.stringify(state, null, 2));
      renameSync(`${path}.tmp`, path);
    } catch {
      // never break the desk over a snapshot; next change retries
    }
  };

  const unsubscribe = store.subscribe((scope) => {
    const t = timers.get(scope);
    if (t) clearTimeout(t);
    timers.set(scope, setTimeout(() => flush(scope), debounceMs));
  });

  return () => {
    for (const [scope, t] of timers) {
      clearTimeout(t);
      flush(scope);
    }
    unsubscribe();
  };
}
