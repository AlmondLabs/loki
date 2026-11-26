import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { CanvasState, Scope } from "../core/canvas-core.ts";
import type { CanvasStore } from "./canvas-store.ts";
import { writeJsonAtomic } from "./json-file.ts";

const DEBOUNCE_MS = 200;

function isCanvasState(v: unknown): v is CanvasState {
  return (
    typeof v === "object" &&
    v !== null &&
    typeof (v as CanvasState).scope === "string" &&
    typeof (v as CanvasState).layout === "object" &&
    typeof (v as CanvasState).overlay === "object"
  );
}

export function loadCanvases(store: CanvasStore, dir: string): Scope[] {
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
      if (isCanvasState(parsed)) {
        store.load({ ...parsed, rev: typeof parsed.rev === "number" ? parsed.rev : 0 });
        loaded.push(parsed.scope);
      }
    } catch {}
  }
  return loaded;
}

const SCOPE_AS_FILE_NAME = /^[A-Za-z0-9_-]+$/;

export function persistCanvases(store: CanvasStore, dir: string, debounceMs = DEBOUNCE_MS): () => void {
  const timers = new Map<Scope, ReturnType<typeof setTimeout>>();

  const flush = (scope: Scope) => {
    timers.delete(scope);
    // Outside (Windows): a backslash also leads out of a folder, so a scope a tab names, such as `..\x`, is not written.
    if (!SCOPE_AS_FILE_NAME.test(scope)) return;
    const state = store.get(scope);
    if (Object.keys(state.layout).length === 0 && Object.keys(state.overlay).length === 0) return;
    try {
      writeJsonAtomic(join(dir, `${scope}.json`), state, { pretty: true });
    } catch {}
  };

  const unsubscribe = store.subscribe((scope) => {
    const t = timers.get(scope);
    if (t) clearTimeout(t);
    timers.set(
      scope,
      setTimeout(() => flush(scope), debounceMs),
    );
  });

  return () => {
    for (const [scope, t] of timers) {
      clearTimeout(t);
      flush(scope);
    }
    unsubscribe();
  };
}
