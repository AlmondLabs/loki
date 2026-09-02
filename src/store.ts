/**
 * Desk state — the single source of truth, owned by the mod process.
 * The browser renders from synced state; every interaction is a patch
 * that round-trips through here. (Tier 0 of the return path.)
 */

export interface WidgetState {
  id: string;
  /** Kit component type, e.g. "info-card". Authored modules come later (U6). */
  type: string;
  title: string;
  position: { x: number; y: number };
  size?: { w: number; h: number };
  z: number;
  /** Widget-specific payload rendered by the kit component. */
  data: unknown;
}

export interface DeskState {
  widgets: Record<string, WidgetState>;
  /** Monotonic revision, bumped per applied patch — lets clients detect gaps. */
  rev: number;
}

export type Patch =
  | { op: "add"; widget: Omit<WidgetState, "z"> }
  | { op: "move"; id: string; position: { x: number; y: number } }
  | { op: "resize"; id: string; size: { w: number; h: number } }
  | { op: "focus"; id: string }
  | { op: "close"; id: string }
  | { op: "set"; id: string; path: string; value: unknown };

export type DeskListener = (state: DeskState, patch: Patch) => void;

const DEFAULT_SCOPE = "desk";

export class DeskStore {
  private desks = new Map<string, DeskState>();
  private listeners = new Map<string, Set<DeskListener>>();

  get(scope: string = DEFAULT_SCOPE): DeskState {
    let desk = this.desks.get(scope);
    if (!desk) {
      desk = { widgets: {}, rev: 0 };
      this.desks.set(scope, desk);
    }
    return desk;
  }

  /** Apply a patch; returns the new state or throws on an invalid patch. */
  apply(patch: Patch, scope: string = DEFAULT_SCOPE): DeskState {
    const desk = this.get(scope);
    const target = "id" in patch ? desk.widgets[patch.id] : undefined;

    switch (patch.op) {
      case "add": {
        if (desk.widgets[patch.widget.id]) throw new Error(`widget exists: ${patch.widget.id}`);
        desk.widgets[patch.widget.id] = { ...patch.widget, z: this.nextZ(desk) };
        break;
      }
      case "move": {
        if (!target) throw new Error(`no widget: ${patch.id}`);
        target.position = patch.position;
        break;
      }
      case "resize": {
        if (!target) throw new Error(`no widget: ${patch.id}`);
        target.size = patch.size;
        break;
      }
      case "focus": {
        if (!target) throw new Error(`no widget: ${patch.id}`);
        if (target.z !== this.topZ(desk)) target.z = this.nextZ(desk);
        break;
      }
      case "close": {
        if (!target) throw new Error(`no widget: ${patch.id}`);
        delete desk.widgets[patch.id];
        break;
      }
      case "set": {
        if (!target) throw new Error(`no widget: ${patch.id}`);
        setPath(target.data, patch.path, patch.value);
        break;
      }
      default:
        throw new Error(`unknown op: ${(patch as { op: string }).op}`);
    }

    desk.rev++;
    for (const fn of this.listeners.get(scope) ?? []) fn(desk, patch);
    return desk;
  }

  subscribe(fn: DeskListener, scope: string = DEFAULT_SCOPE): () => void {
    let set = this.listeners.get(scope);
    if (!set) {
      set = new Set();
      this.listeners.set(scope, set);
    }
    set.add(fn);
    return () => set.delete(fn);
  }

  private topZ(desk: DeskState): number {
    return Math.max(0, ...Object.values(desk.widgets).map((w) => w.z));
  }

  private nextZ(desk: DeskState): number {
    return this.topZ(desk) + 1;
  }
}

/** Set a dot-path inside widget data, creating objects along the way. */
function setPath(data: unknown, path: string, value: unknown): void {
  if (typeof data !== "object" || data === null) throw new Error("widget data is not an object");
  const keys = path.split(".");
  let node = data as Record<string, unknown>;
  for (const key of keys.slice(0, -1)) {
    if (typeof node[key] !== "object" || node[key] === null) node[key] = {};
    node = node[key] as Record<string, unknown>;
  }
  node[keys[keys.length - 1]] = value;
}

/** First-run desk so the canvas is never empty during the spike. */
export function seedDesk(store: DeskStore, scope?: string): void {
  if (Object.keys(store.get(scope).widgets).length > 0) return;
  store.apply(
    {
      op: "add",
      widget: {
        id: "welcome",
        type: "info-card",
        title: "loci",
        position: { x: 120, y: 120 },
        data: {
          lines: ["a memory palace your agent builds", "drag me by the title bar · U2"],
        },
      },
    },
    scope,
  );
}
