import type { WidgetManifestEntry } from "../../core/desk-core.ts";
import { createBridge, type BridgeDeps } from "../../mod/bridge.ts";
import { frameModules, welcomeFrames, type ModuleDeps } from "../../mod/frames/index.ts";
import { DeskStore } from "../../mod/desk-store.ts";
import { GestureLog } from "../../mod/gestures.ts";
import type { Client } from "../../mod/server.ts";
import type { WidgetsWatcher } from "../../mod/widgets-fs.ts";
import { OLD_KEYS } from "../../core/snake-keys.ts";

const DATA_FIELDS = new Set(["data", "overlay", "layout", "input", "args", "metadata"]);

export function assertSnakeCase(frame: unknown, path = "frame"): void {
  if (Array.isArray(frame)) return frame.forEach((v, i) => assertSnakeCase(v, `${path}[${i}]`));
  if (!frame || typeof frame !== "object") return;
  for (const [k, v] of Object.entries(frame)) {
    const now = OLD_KEYS[k];
    if (now) throw new Error(`${path}.${k} is camelCase; on the wire it is ${now}`);
    if (!DATA_FIELDS.has(k)) assertSnakeCase(v, `${path}.${k}`);
  }
}

export function client(scope: string, deviceId?: string, peerId?: string): Client & { sent: Array<Record<string, unknown>> } {
  const sent: Array<Record<string, unknown>> = [];
  return {
    scope,
    sent,
    ...(deviceId ? { deviceId } : {}),
    ...(peerId ? { peerId } : {}),
    send: (m) => {
      assertSnakeCase(m);
      sent.push(m as Record<string, unknown>);
    },
  };
}

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
    close: () => {},
  };
}

type BridgeOf = Partial<ModuleDeps> & { broadcast?: BridgeDeps["broadcast"]; capture?: BridgeDeps["capture"]; modules?: BridgeDeps["modules"] };

export function bridgeOf(deps: BridgeOf = {}) {
  const full: ModuleDeps = { store: new DeskStore(), widgets: fakeWidgets([]), gestures: new GestureLog(), ...deps };
  return createBridge({
    modules: deps.modules ?? frameModules(full),
    welcome: welcomeFrames(full),
    broadcast: deps.broadcast ?? (() => {}),
    capture: deps.capture,
  });
}

export function bridgeWith(deps: BridgeOf = {}) {
  const broadcasts: Array<{ frame: Record<string, unknown>; scope?: string }> = [];
  const bridge = bridgeOf({
    ...deps,
    broadcast: (frame, scope) => (assertSnakeCase(frame), broadcasts.push({ frame: frame as Record<string, unknown>, scope })),
  });
  return { bridge, broadcasts };
}

export const settled = () => new Promise((r) => setTimeout(r, 0));
