export const SIDEBAR_MIN = 200;
export const SIDEBAR_MAX = 300;
export const SIDEBAR_DEFAULT = 220;
export const LIST_MIN = 260;
export const LIST_MAX = 420;
export const LIST_DEFAULT = 300;
export const DETAIL_MIN = 480;
export const COLUMNS_KEY = "loki.desktop.column";

export interface ColumnsPref {
  sidebar: number;
  list: number;
  collapsed: boolean;
  listHidden: boolean;
}

export interface ColumnsFrame {
  windowWidth: number;
  inset: number;
  clearance: number;
  hasList: boolean;
  peek: boolean;
}

export interface ColumnsLayout {
  sidebarShown: boolean;
  sidebarOver: boolean;
  listShown: boolean;
  listLeft: number;
  list: number;
  detailLeft: number;
}

const DEFAULTS: ColumnsPref = { sidebar: SIDEBAR_DEFAULT, list: LIST_DEFAULT, collapsed: false, listHidden: false };

const clampTo = (min: number, max: number, fallback: number, w: unknown): number =>
  typeof w === "number" && Number.isFinite(w) ? Math.min(max, Math.max(min, Math.round(w))) : fallback;

export function clampSidebar(w: unknown): number {
  return clampTo(SIDEBAR_MIN, SIDEBAR_MAX, SIDEBAR_DEFAULT, w);
}

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

export function loadColumns(store: Store | null): ColumnsPref {
  try {
    const raw = store?.getItem(COLUMNS_KEY);
    if (!raw) return DEFAULTS;
    const v: unknown = JSON.parse(raw);
    if (typeof v !== "object" || v === null) return DEFAULTS;
    const saved = v as Record<string, unknown>;
    return {
      sidebar: clampSidebar(saved.width),
      list: clampList(saved.list),
      collapsed: saved.collapsed === true,
      listHidden: saved.list_hidden === true,
    };
  } catch {
    return DEFAULTS;
  }
}

export function saveColumns(store: Store | null, pref: ColumnsPref): void {
  try {
    store?.setItem(
      COLUMNS_KEY,
      JSON.stringify({ width: clampSidebar(pref.sidebar), collapsed: pref.collapsed, list: clampList(pref.list), list_hidden: pref.listHidden }),
    );
  } catch {}
}

export function sidebarFits(pref: ColumnsPref, frame: Pick<ColumnsFrame, "windowWidth" | "inset" | "hasList">): boolean {
  const list = frame.hasList && !pref.listHidden ? pref.list : 0;
  return frame.windowWidth >= frame.inset * 2 + pref.sidebar + list + DETAIL_MIN;
}

export function columnsLayout(pref: ColumnsPref, frame: ColumnsFrame): ColumnsLayout {
  const fits = sidebarFits(pref, frame);
  const beside = fits && !pref.collapsed;
  const sidebarOver = !fits && frame.peek;
  const listLeft = beside ? frame.inset * 2 + pref.sidebar : frame.clearance;
  const listShown = frame.hasList && !pref.listHidden;
  const list = listShown ? Math.max(LIST_MIN, Math.min(pref.list, frame.windowWidth - listLeft - DETAIL_MIN)) : 0;
  return { sidebarShown: beside || sidebarOver, sidebarOver, listShown, listLeft, list, detailLeft: listLeft + list };
}

export function toggleList(pref: ColumnsPref): ColumnsPref {
  return { ...pref, listHidden: !pref.listHidden };
}

export function toggleSidebar(pref: ColumnsPref, fits: boolean, peek: boolean): { pref: ColumnsPref; peek: boolean } {
  if (!fits) return { pref, peek: !peek };
  return { pref: { ...pref, collapsed: !pref.collapsed }, peek: false };
}

export function keptPeek(peek: boolean, fits: boolean): boolean {
  return peek && !fits;
}
