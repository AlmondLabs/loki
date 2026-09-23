import type { Segment } from "./keymap";

/**
 * The list column between the rail and the main pane, Slack's second column (plan 013 U3). Pure, so the
 * rules are tested without a window: which sections have one, its width range, what is kept across
 * reloads, and the fold below NARROW_BELOW. A narrow window folds the column away on its own; the toggle
 * then opens it for this window ("peek") without touching the saved preference, so widening the window
 * again brings back what the person chose.
 */

export const COLUMN_MIN = 220;
export const COLUMN_MAX = 420;
export const COLUMN_DEFAULT = 260;
/** Windows narrower than this fold the column away until asked for. */
export const NARROW_BELOW = 1100;
export const COLUMN_KEY = "loki.desktop.column";

export interface ColumnPref {
  width: number;
  collapsed: boolean;
}

/** Inbox is its own full-width pass and Settings a page of its own; the rest list their items. */
export function hasColumn(segment: Segment): boolean {
  return segment === "desk" || segment === "board" || segment === "agents" || segment === "learn";
}

export function clampColumn(w: number): number {
  if (!Number.isFinite(w)) return COLUMN_DEFAULT;
  return Math.min(COLUMN_MAX, Math.max(COLUMN_MIN, Math.round(w)));
}

type Store = Pick<Storage, "getItem" | "setItem">;

/** localStorage when the page may use it; a blocked site throws on the global itself, and reads as none. */
export function columnStore(): Store | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

export function loadColumn(store: Store | null): ColumnPref {
  try {
    const raw = store?.getItem(COLUMN_KEY);
    if (!raw) return { width: COLUMN_DEFAULT, collapsed: false };
    const v = JSON.parse(raw) as Partial<ColumnPref>;
    return { width: clampColumn(typeof v.width === "number" ? v.width : Number.NaN), collapsed: v.collapsed === true };
  } catch {
    return { width: COLUMN_DEFAULT, collapsed: false };
  }
}

export function saveColumn(store: Store | null, pref: ColumnPref): void {
  try {
    store?.setItem(COLUMN_KEY, JSON.stringify({ width: clampColumn(pref.width), collapsed: pref.collapsed }));
  } catch {
    // a blocked store only costs the preference across reloads
  }
}

/** Is the column on screen (for a section that has one)? */
export function columnShown(pref: ColumnPref, windowWidth: number, peek: boolean): boolean {
  return windowWidth < NARROW_BELOW ? peek : !pref.collapsed;
}

/** The toggle (the rail button, ⌘⇧D): narrow windows peek, wide ones flip the saved collapse. */
export function toggleColumn(pref: ColumnPref, windowWidth: number, peek: boolean): { pref: ColumnPref; peek: boolean } {
  if (windowWidth < NARROW_BELOW) return { pref, peek: !peek };
  return { pref: { ...pref, collapsed: !pref.collapsed }, peek: false };
}
