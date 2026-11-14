/**
 * The window's columns, as Mail's (plan 2026-11-14-1330, KTD1): the sidebar of places and sources, the list of the
 * source's items, and the detail in the space they leave. Pure, so the rules are tested without a window: both
 * widths and their ranges, what is kept across reloads, and the fold, which is computed from the widths rather than
 * a fixed breakpoint. A window that cannot keep the detail at DETAIL_MIN beside both columns folds the sidebar away
 * on its own; the toggle then shows it over the window for now ("peek") without touching the saved fold, so
 * widening the window again brings back what the person chose. The list never folds on its own: it narrows to
 * LIST_MIN first, and only then does the detail give way, which only a browser tab is narrow enough to reach.
 */

/** The sidebar's narrowest width in px. */
export const SIDEBAR_MIN = 200;
/** The sidebar's widest width in px. */
export const SIDEBAR_MAX = 300;
/** The sidebar's width in px until the person drags it. */
export const SIDEBAR_DEFAULT = 220;
/** The list's narrowest width in px; a narrow window narrows it this far before the detail gives way. */
export const LIST_MIN = 260;
/** The list's widest width in px. */
export const LIST_MAX = 420;
/** The list's width in px until the person changes it. */
export const LIST_DEFAULT = 300;
/** The detail's narrowest width in px that a thread or a page still reads in; the sidebar folds to keep it. */
export const DETAIL_MIN = 480;
/** The localStorage key both columns are kept under; its name predates the list, whose width it gained. */
export const COLUMNS_KEY = "loki.desktop.column";

/** The columns as the person left them: both widths in px, and whether they folded the sidebar away. */
export interface ColumnsPref {
  sidebar: number;
  list: number;
  collapsed: boolean;
}

/** What the window gives the columns: its width, and what the place and the platform take from it, in px. */
export interface ColumnsFrame {
  windowWidth: number;
  /** The glass sidebar's gap from the window's edge; it leaves the same gap again before the list. */
  inset: number;
  /** Where the list starts with the sidebar folded: past the traffic lights and the toggle on the Mac, the toggle elsewhere. */
  clearance: number;
  /** Whether the showing place has a list column; a place without one gives the detail that room. */
  hasList: boolean;
  /** Whether the person asked for the folded sidebar this time. */
  peek: boolean;
}

/** Where each column goes, in px from the window's left edge. */
export interface ColumnsLayout {
  /** The sidebar is on screen. */
  sidebarShown: boolean;
  /** The sidebar shows over the list and the detail rather than beside them: a peek at a folded sidebar. */
  sidebarOver: boolean;
  listLeft: number;
  /** The list's width, 0 for a place without one. */
  list: number;
  detailLeft: number;
}

const DEFAULTS: ColumnsPref = { sidebar: SIDEBAR_DEFAULT, list: LIST_DEFAULT, collapsed: false };

const clampTo = (min: number, max: number, fallback: number, w: unknown): number =>
  typeof w === "number" && Number.isFinite(w) ? Math.min(max, Math.max(min, Math.round(w))) : fallback;

/** A width the sidebar may take, in px: rounded and kept within its range; anything not a number is the default. */
export function clampSidebar(w: unknown): number {
  return clampTo(SIDEBAR_MIN, SIDEBAR_MAX, SIDEBAR_DEFAULT, w);
}

/** A width the list may take, in px: rounded and kept within its range; anything not a number is the default. */
export function clampList(w: unknown): number {
  return clampTo(LIST_MIN, LIST_MAX, LIST_DEFAULT, w);
}

type Store = Pick<Storage, "getItem" | "setItem">;

/** localStorage when the page may use it; a blocked site throws on the global itself, and reads as none. */
export function columnsStore(): Store | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

/**
 * The columns as saved in `store`; the defaults when nothing is saved or it cannot be read. The saved shape is the
 * one-column window's `{width, collapsed}`, its width now the sidebar's, plus `list`: an old width up to 420 is
 * clamped into the sidebar's range rather than trusted.
 */
export function loadColumns(store: Store | null): ColumnsPref {
  try {
    const raw = store?.getItem(COLUMNS_KEY);
    if (!raw) return DEFAULTS;
    const v: unknown = JSON.parse(raw);
    if (typeof v !== "object" || v === null) return DEFAULTS;
    const saved = v as Record<string, unknown>;
    return { sidebar: clampSidebar(saved.width), list: clampList(saved.list), collapsed: saved.collapsed === true };
  } catch {
    return DEFAULTS;
  }
}

/** Save the columns to `store`, their widths clamped; a blocked store saves nothing and does not throw. */
export function saveColumns(store: Store | null, pref: ColumnsPref): void {
  try {
    store?.setItem(COLUMNS_KEY, JSON.stringify({ width: clampSidebar(pref.sidebar), collapsed: pref.collapsed, list: clampList(pref.list) }));
  } catch {
    // a blocked store only costs the preference across reloads
  }
}

/** Does the window keep the detail at DETAIL_MIN beside the sidebar, and the list where the place has one? */
export function sidebarFits(pref: ColumnsPref, frame: Pick<ColumnsFrame, "windowWidth" | "inset" | "hasList">): boolean {
  return frame.windowWidth >= frame.inset * 2 + pref.sidebar + (frame.hasList ? pref.list : 0) + DETAIL_MIN;
}

/** Where the columns go: the sidebar beside the rest when it fits and is not folded, else the list from the clearance, narrowed to keep the detail. */
export function columnsLayout(pref: ColumnsPref, frame: ColumnsFrame): ColumnsLayout {
  const fits = sidebarFits(pref, frame);
  const beside = fits && !pref.collapsed;
  const sidebarOver = !fits && frame.peek;
  const listLeft = beside ? frame.inset * 2 + pref.sidebar : frame.clearance;
  const list = frame.hasList ? Math.max(LIST_MIN, Math.min(pref.list, frame.windowWidth - listLeft - DETAIL_MIN)) : 0;
  return { sidebarShown: beside || sidebarOver, sidebarOver, listLeft, list, detailLeft: listLeft + list };
}

/** The toggle (the toolbar button, ⌃⌘S): a folded sidebar peeks; one that fits flips the saved fold and drops any peek. */
export function toggleSidebar(pref: ColumnsPref, fits: boolean, peek: boolean): { pref: ColumnsPref; peek: boolean } {
  if (!fits) return { pref, peek: !peek };
  return { pref: { ...pref, collapsed: !pref.collapsed }, peek: false };
}

/**
 * A folded sidebar's peek, kept only while the sidebar does not fit: once the window widens to fit it the peek is
 * spent, so narrowing the window again does not bring the sidebar back over the content unasked.
 */
export function keptPeek(peek: boolean, fits: boolean): boolean {
  return peek && !fits;
}
