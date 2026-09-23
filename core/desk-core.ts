/**
 * desk-core — the vocabulary both halves of loki speak.
 * Imported by the mod (Node, type-stripped) and by the canvas app (Vite).
 * Pure data and pure functions only: no I/O, no framework imports.
 */

/** A desk scope: "shared" or a sanitized conversation id. */
export type Scope = string;
export const SHARED_SCOPE: Scope = "shared";

export interface Position {
  x: number;
  y: number;
}
export interface Size {
  w: number;
  h: number;
}

/** Server-owned geometry for one widget. The agent never writes this. */
export interface WidgetLayout {
  position: Position;
  size?: Size;
  z: number;
  /**
   * The size came from a human dragging the resize handle, not from measuring the content.
   * A sized frame keeps that width and height (content scrolls inside it); an unsized frame
   * sizes itself to its content, up to WIDGET_MAX_WIDTH.
   */
  sized?: boolean;
  /** User closed the widget; the file still exists. The agent may delete it. */
  hidden?: boolean;
}

export type WidgetKind = "json" | "module";

/** What the mod learned about one widget file on disk. Agent-owned content. */
export interface WidgetManifestEntry {
  /** "<scope>/<name>" — stable id used by layout, overlay, gestures, camera. */
  id: string;
  scope: Scope;
  name: string;
  kind: WidgetKind;
  /** Path relative to the app's widgets root, e.g. "shared/sleep.json". */
  file: string;
  title: string;
  /** Kit type for json widgets. */
  type?: string;
  /** json: the file's data. module: {} (modules may export `data`, merged app-side). */
  data: Record<string, unknown>;
  hash: string;
  /** Syntax/parse error found by the mod, or runtime error reported by the tab. */
  error?: string;
  updatedAt: number;
}

export type WidgetChange = "added" | "changed" | "removed";

/**
 * One row of a desk's widget change log (mod/widget-log.ts): the agent added, changed or removed a
 * widget file. Sent as `widget_change { entry }` and with the desk's history (`widgetLog`).
 */
export interface WidgetLogEntry {
  /** Unique per row. A collapsed repeat edit keeps the row's id with a later `at`: replace, don't append. */
  id: string;
  /** Epoch ms of the change (the latest one, for a collapsed row). */
  at: number;
  scope: Scope;
  /** The widget's "<scope>/<name>" id, as in WidgetManifestEntry.id. */
  widgetId: string;
  name: string;
  title: string;
  kind: WidgetKind;
  change: WidgetChange;
}

/** Server-owned state for one desk. Snapshotted to disk when non-empty. */
export interface DeskState {
  scope: Scope;
  layout: Record<string, WidgetLayout>;
  /** Gesture writes onto widget data: widgetId → dot-path → value. Cleared when the file changes. */
  overlay: Record<string, Record<string, unknown>>;
  rev: number;
}

/** A user gesture on the canvas. The only thing the browser may say about state. */
export type Gesture =
  | { kind: "move"; id: string; position: Position }
  | { kind: "resize"; id: string; size: Size }
  | { kind: "focus"; id: string }
  | { kind: "close"; id: string }
  /** Undo a close from the canvas; the inverse of `close`. */
  | { kind: "open"; id: string }
  /** `prev` is the value the tab saw before the gesture; module widgets keep their initial data client-side. */
  | { kind: "set"; id: string; path: string; value: unknown; prev?: unknown };

export function emptyDesk(scope: Scope): DeskState {
  return { scope, layout: {}, overlay: {}, rev: 0 };
}

export function topZ(layout: Record<string, WidgetLayout>): number {
  let top = 0;
  for (const l of Object.values(layout)) if (l.z > top) top = l.z;
  return top;
}

/** Cascade placement for widgets the agent did not position (client-side fallback until the mod assigns one). */
export function autoPlace(index: number): Position {
  return { x: 140 + (index % 6) * 60, y: 120 + (index % 6) * 48 };
}

export interface Rect extends Position, Size {}

/** Frames are 280 wide by default; height is unknown until the tab measures it. */
export const DEFAULT_SIZE: Size = { w: 280, h: 160 };
/** An auto-sized frame grows to its content up to this width, then the content scrolls; a reading measure, matching the centred chat. */
export const WIDGET_MAX_WIDTH = 760;
/** Smallest a human may drag a frame; below this is a mis-grab, not an intent. */
export const RESIZE_MIN: Size = { w: 200, h: 120 };
export const ORIGIN: Position = { x: 120, y: 120 };
/** Breathing room between widgets, and how wide a row grows before wrapping. */
export const GAP = 24;
export const ROW_WIDTH = 1280;

export function rectOf(layout: WidgetLayout): Rect {
  return { ...layout.position, w: layout.size?.w ?? DEFAULT_SIZE.w, h: layout.size?.h ?? DEFAULT_SIZE.h };
}

/** Occupied rectangles of the visible widgets in a desk. */
export function occupiedRects(state: DeskState): Rect[] {
  return Object.values(state.layout)
    .filter((l) => !l.hidden)
    .map(rectOf);
}

const overlaps = (a: Rect, b: Rect, gap: number) =>
  a.x < b.x + b.w + gap && a.x + a.w + gap > b.x && a.y < b.y + b.h + gap && a.y + a.h + gap > b.y;

/**
 * First free spot for a widget of `size`: the origin, or to the right of / below
 * an existing widget, whichever is nearest the top-left without overlapping
 * anything and without running past the row width. Reads left to right, top
 * to bottom, the way a person tidies a desk.
 */
export function findFreeSpot(obstacles: Rect[], size: Size = DEFAULT_SIZE, opts: { origin?: Position; rowWidth?: number; gap?: number } = {}): Position {
  const origin = opts.origin ?? ORIGIN;
  const rowWidth = opts.rowWidth ?? ROW_WIDTH;
  const gap = opts.gap ?? GAP;
  const candidates: Position[] = [origin];
  for (const o of obstacles) {
    candidates.push({ x: o.x + o.w + gap, y: o.y });
    candidates.push({ x: o.x, y: o.y + o.h + gap });
    candidates.push({ x: origin.x, y: o.y + o.h + gap });
  }
  let best: Position | null = null;
  let bestScore = Infinity;
  for (const c of candidates) {
    if (c.x + size.w > origin.x + rowWidth) continue;
    const r: Rect = { ...c, ...size };
    if (obstacles.some((o) => overlaps(r, o, gap - 1))) continue;
    const score = (c.y - origin.y) * 1 + (c.x - origin.x) * 0.35;
    if (score < bestScore) {
      bestScore = score;
      best = c;
    }
  }
  // Nothing fits in the rows: start a new row under everything.
  if (!best) {
    const bottom = obstacles.reduce((m, o) => Math.max(m, o.y + o.h), origin.y - gap);
    best = { x: origin.x, y: bottom + gap };
  }
  return best;
}

/**
 * Give a widget a layout entry if it has none, in the first free spot given
 * everything else on screen (this desk plus the shared widgets shown with it).
 */
export function ensureLayout(state: DeskState, id: string, obstacles: Rect[] = occupiedRects(state), size: Size = DEFAULT_SIZE): DeskState {
  if (state.layout[id]) return state;
  return {
    ...state,
    layout: { ...state.layout, [id]: { position: findFreeSpot(obstacles, size), z: topZ(state.layout) + 1 } },
    rev: state.rev + 1,
  };
}

/** Record the rendered size of a widget (reported by the tab). No-op if unchanged. */
/** Smallest size a rendered widget frame can honestly have; anything under it is a transient layout glitch, not a measurement. */
export const MIN_FRAME = { w: 80, h: 40 };

export function applyMeasure(state: DeskState, id: string, size: Size): DeskState {
  const l = state.layout[id];
  if (!l) return state;
  const w = Math.round(size.w);
  const h = Math.round(size.h);
  if (!Number.isFinite(w) || !Number.isFinite(h) || w < MIN_FRAME.w || h < MIN_FRAME.h) return state; // never persist a collapsed frame
  if (l.size && Math.abs(l.size.w - w) < 2 && Math.abs(l.size.h - h) < 2) return state;
  return { ...state, layout: { ...state.layout, [id]: { ...l, size: { w, h } } }, rev: state.rev + 1 };
}

/**
 * Tidy a desk: re-place its visible widgets in reading order (current top-left
 * first) into a packed grid, flowing around `fixed` rectangles (e.g. the shared
 * widgets). Hidden widgets and z-order are untouched.
 */
export function arrangeLayout(state: DeskState, fixed: Rect[] = []): DeskState {
  const ids = Object.entries(state.layout)
    .filter(([, l]) => !l.hidden)
    .sort(([, a], [, b]) => a.position.y - b.position.y || a.position.x - b.position.x)
    .map(([id]) => id);
  if (ids.length === 0) return state;
  const placed: Rect[] = [...fixed];
  const layout = { ...state.layout };
  for (const id of ids) {
    const size = layout[id].size ?? DEFAULT_SIZE;
    const position = findFreeSpot(placed, size);
    layout[id] = { ...layout[id], position };
    placed.push({ ...position, ...size });
  }
  return { ...state, layout, rev: state.rev + 1 };
}

/** Apply a gesture immutably. Unknown ids are created on move/resize/focus (the file may have just landed). */
export function applyGesture(state: DeskState, g: Gesture): DeskState {
  const base = g.kind === "set" ? state : ensureLayout(state, g.id);
  const layout = { ...base.layout };
  const overlay = { ...base.overlay };
  const current = layout[g.id];
  switch (g.kind) {
    case "move":
      layout[g.id] = { ...current, position: g.position };
      break;
    case "resize":
      // A human pinned the size: keep it, and stop auto-sizing to content.
      layout[g.id] = { ...current, size: g.size, sized: true };
      break;
    case "focus": {
      const top = topZ(layout);
      if (current.z !== top) layout[g.id] = { ...current, z: top + 1 };
      break;
    }
    case "close":
      layout[g.id] = { ...current, hidden: true };
      break;
    case "open":
      layout[g.id] = { ...current, hidden: false, z: topZ(layout) + 1 };
      break;
    case "set":
      overlay[g.id] = { ...(overlay[g.id] ?? {}), [g.path]: g.value };
      break;
  }
  return { ...base, layout, overlay, rev: base.rev + 1 };
}

/** Drop gesture overrides for a widget — used when the agent rewrites its file. */
export function clearOverlay(state: DeskState, id: string): DeskState {
  if (!state.overlay[id]) return state;
  const overlay = { ...state.overlay };
  delete overlay[id];
  return { ...state, overlay, rev: state.rev + 1 };
}

/** Drop everything the desk knows about a widget (its file is gone). */
export function forgetWidget(state: DeskState, id: string): DeskState {
  if (!state.layout[id] && !state.overlay[id]) return state;
  const layout = { ...state.layout };
  const overlay = { ...state.overlay };
  delete layout[id];
  delete overlay[id];
  return { ...state, layout, overlay, rev: state.rev + 1 };
}

/** Un-hide a widget (its file changed after the user minimised it, so the agent meant it). */
export function reveal(state: DeskState, id: string): DeskState {
  const l = state.layout[id];
  if (!l?.hidden) return state;
  return { ...state, layout: { ...state.layout, [id]: { ...l, hidden: false } }, rev: state.rev + 1 };
}

/** Set a dot-path on a plain object, creating intermediate objects. Mutates `obj`. */
export function setPath(obj: Record<string, unknown>, path: string, value: unknown): void {
  const keys = path.split(".");
  let node = obj;
  for (const key of keys.slice(0, -1)) {
    const next = node[key];
    if (typeof next !== "object" || next === null) node[key] = {};
    node = node[key] as Record<string, unknown>;
  }
  node[keys[keys.length - 1]] = value;
}

/** Read a dot-path, or undefined. */
export function getPath(obj: unknown, path: string): unknown {
  let node: unknown = obj;
  for (const key of path.split(".")) {
    if (typeof node !== "object" || node === null) return undefined;
    node = (node as Record<string, unknown>)[key];
  }
  return node;
}

/** File data with the gesture overlay applied. Never mutates inputs. */
export function mergeData(
  data: Record<string, unknown>,
  overlay: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const out = structuredClone(data);
  if (overlay) for (const [path, value] of Object.entries(overlay)) setPath(out, path, value);
  return out;
}

/**
 * Conversation id → filesystem-safe scope. An agent's main chat is its
 * "default" conversation, whose id is literally `default`, so that one is
 * keyed by agent too or every agent's main chat would share a desk.
 */
export function scopeFor(conversationId: string | null | undefined, agentId?: string | null): Scope {
  if (!conversationId) return SHARED_SCOPE;
  const raw = conversationId === "default" && agentId ? `default-${agentId}` : conversationId;
  const s = raw.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 100);
  return s || SHARED_SCOPE;
}

/** The local backend names files/dirs with unpadded base64 of a key. Works in Node and the browser (no Buffer there). */
export function backendName(key: string): string {
  const bytes = new TextEncoder().encode(key);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  const b64 = typeof btoa === "function" ? btoa(bin) : Buffer.from(bytes).toString("base64");
  return b64.replace(/=+$/, "");
}

/** Local-backend directory name for a conversation. Default conversations live under `default:<agentId>`. */
export function conversationDirName(conversationId: string, agentId?: string | null): string {
  return backendName(conversationId === "default" && agentId ? `default:${agentId}` : `conversation:${conversationId}`);
}

/** The kit vocabulary — one line per type, what the agent reads. */
export const KIT: Record<string, { dataShape: string }> = {
  "info-card": { dataShape: "{ lines: string[] }" },
  stat: { dataShape: "{ value: string|number, label?: string, unit?: string, delta?: number }" },
  "slider-control": {
    dataShape: "{ label: string, value: number, min: number, max: number, step?: number, unit?: string }",
  },
  "list-card": { dataShape: "{ items: Array<{ text: string, done?: boolean }> }" },
  "chart-card": {
    dataShape:
      '{ kind: "line"|"bar"|"area", points: Array<{ x: string|number, y: number }>, yLabel?: string }',
  },
};
export const KIT_TYPES: string[] = Object.keys(KIT);
