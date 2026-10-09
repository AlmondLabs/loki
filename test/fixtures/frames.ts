import type { WidgetManifestEntry } from "../../core/desk-core.ts";
import { createBridge, type BridgeDeps } from "../../mod/bridge.ts";
import { DeskStore } from "../../mod/desk-store.ts";
import { GestureLog } from "../../mod/gestures.ts";
import type { Client } from "../../mod/server.ts";
import type { WidgetsWatcher } from "../../mod/widgets-fs.ts";

/** A client that records what the mod sent it; a `deviceId` makes it a paired phone. */
export function client(scope: string, deviceId?: string): Client & { sent: Array<Record<string, unknown>> } {
  const sent: Array<Record<string, unknown>> = [];
  return { scope, sent, ...(deviceId ? { deviceId } : {}), send: (m) => sent.push(m as Record<string, unknown>) };
}

/** A widget watcher over fixed entries, with runtime errors kept in memory. */
export function fakeWidgets(entries: WidgetManifestEntry[]): WidgetsWatcher & { runtime: Map<string, string> } {
  const runtime = new Map<string, string>();
  return {
    runtime,
    entries: (scope) => entries.filter((e) => !scope || e.scope === scope).map((e) => (runtime.has(e.id) ? { ...e, error: runtime.get(e.id) } : e)),
    get: (id) => entries.find((e) => e.id === id),
    setRuntimeError(id, msg) {
      const prev = runtime.get(id) ?? null;
      if (prev === msg) return false;
      if (msg) runtime.set(id, msg);
      else runtime.delete(id);
      return true;
    },
    rescan: async () => {},
    close() {},
  };
}

/** A bridge over in-memory desks with the given modules, and every broadcast it made. */
export function bridgeWith(deps: Partial<BridgeDeps> = {}) {
  const broadcasts: Array<{ frame: Record<string, unknown>; scope?: string }> = [];
  const bridge = createBridge({ store: new DeskStore(), widgets: fakeWidgets([]), gestures: new GestureLog(), broadcast: (frame, scope) => broadcasts.push({ frame: frame as Record<string, unknown>, scope }), ...deps });
  return { bridge, broadcasts };
}

/** Let a handler's promise settle. */
export const settled = () => new Promise((r) => setTimeout(r, 0));
