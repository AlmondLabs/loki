import { describe, expect, test } from "vitest";
import {
  COLUMNS_KEY,
  DETAIL_MIN,
  LIST_DEFAULT,
  LIST_MIN,
  SIDEBAR_DEFAULT,
  SIDEBAR_MAX,
  SIDEBAR_MIN,
  clampSidebar,
  columnsLayout,
  columnsStore,
  loadColumns,
  saveColumns,
  sidebarFits,
  toggleSidebar,
  type ColumnsFrame,
} from "../app/src/shell/columns.ts";

/**
 * The window's columns (plan 2026-11-14-1330, KTD1): the sidebar and the list keep their widths across reloads, the
 * sidebar folds when the detail would drop under 480, and the list narrows before the detail gives way.
 */

const memory = (seed: Record<string, string> = {}) => {
  const m = new Map(Object.entries(seed));
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), m };
};

const DEFAULTS = { sidebar: SIDEBAR_DEFAULT, list: LIST_DEFAULT, collapsed: false };
/** The Mac's frame: the glass inset of 8, and the traffic lights and toggle's clearance of 128. */
const mac = (windowWidth: number, more: Partial<ColumnsFrame> = {}): ColumnsFrame => ({
  windowWidth,
  inset: 8,
  clearance: 128,
  hasList: true,
  peek: false,
  ...more,
});

describe("columns: widths", () => {
  test("the ranges and defaults", () => {
    expect([SIDEBAR_MIN, SIDEBAR_MAX, SIDEBAR_DEFAULT]).toEqual([200, 300, 220]);
    expect([LIST_MIN, LIST_DEFAULT, DETAIL_MIN]).toEqual([260, 300, 480]);
    expect(clampSidebar(100)).toBe(200);
    expect(clampSidebar(250.6)).toBe(251);
    expect(clampSidebar(Number.NaN)).toBe(SIDEBAR_DEFAULT);
  });
});

describe("columns: where they go", () => {
  test("at 1440 with the defaults, the sidebar is 220 and the list 300, and the detail starts after both", () => {
    expect(columnsLayout(DEFAULTS, mac(1440))).toEqual({ sidebarShown: true, sidebarOver: false, listLeft: 236, list: 300, detailLeft: 536 });
  });
  test("the sidebar folds below inset + sidebar + list + 480, 1016 at the defaults", () => {
    expect(sidebarFits(DEFAULTS, mac(1016))).toBe(true);
    expect(sidebarFits(DEFAULTS, mac(1015))).toBe(false);
  });
  test("at 1000, the sidebar is folded, the list starts after the 128 clearance, and the detail keeps at least 480", () => {
    const at = columnsLayout(DEFAULTS, mac(1000));
    expect(at).toEqual({ sidebarShown: false, sidebarOver: false, listLeft: 128, list: 300, detailLeft: 428 });
    expect(1000 - at.detailLeft).toBeGreaterThanOrEqual(480);
  });
  test("at the Mac's 900, the list is 292 and the detail 480", () => {
    const at = columnsLayout(DEFAULTS, mac(900));
    expect(at.list).toBe(292);
    expect(900 - at.detailLeft).toBe(480);
  });
  test("with a browser's clearance of 52 at 700, the list stays at 260 and only the detail gives way", () => {
    const at = columnsLayout(DEFAULTS, { windowWidth: 700, inset: 8, clearance: 52, hasList: true, peek: false });
    expect(at).toEqual({ sidebarShown: false, sidebarOver: false, listLeft: 52, list: 260, detailLeft: 312 });
  });
  test("a place without a list counts none: the sidebar stays at the Mac's 900, and the detail starts after it", () => {
    expect(columnsLayout(DEFAULTS, mac(900, { hasList: false }))).toEqual({ sidebarShown: true, sidebarOver: false, listLeft: 236, list: 0, detailLeft: 236 });
    expect(sidebarFits(DEFAULTS, mac(715, { hasList: false }))).toBe(false);
  });
  test("a sidebar folded by choice leaves the list at the clearance", () => {
    expect(columnsLayout({ ...DEFAULTS, collapsed: true }, mac(1440))).toEqual({
      sidebarShown: false,
      sidebarOver: false,
      listLeft: 128,
      list: 300,
      detailLeft: 428,
    });
  });
});

describe("columns: the toggle", () => {
  test("at a narrow width it peeks over the window without changing the saved fold or moving the list", () => {
    const fits = sidebarFits(DEFAULTS, mac(900));
    expect(toggleSidebar(DEFAULTS, fits, false)).toEqual({ pref: DEFAULTS, peek: true });
    expect(toggleSidebar(DEFAULTS, fits, true)).toEqual({ pref: DEFAULTS, peek: false });
    expect(columnsLayout(DEFAULTS, mac(900, { peek: true }))).toEqual({ sidebarShown: true, sidebarOver: true, listLeft: 128, list: 292, detailLeft: 420 });
  });
  test("where the sidebar fits it flips the saved fold and drops any peek", () => {
    expect(toggleSidebar(DEFAULTS, true, false)).toEqual({ pref: { ...DEFAULTS, collapsed: true }, peek: false });
    expect(toggleSidebar({ ...DEFAULTS, collapsed: true }, true, true)).toEqual({ pref: DEFAULTS, peek: false });
  });
});

describe("columns: persistence", () => {
  test("nothing stored reads as the defaults", () => {
    expect(loadColumns(memory())).toEqual(DEFAULTS);
  });
  test("the one-column window's {width: 400, collapsed: false} loads as a sidebar of 300 with the default list", () => {
    expect(loadColumns(memory({ [COLUMNS_KEY]: JSON.stringify({ width: 400, collapsed: false }) }))).toEqual({ sidebar: 300, list: 300, collapsed: false });
  });
  test("both widths and the fold come back across a reload, under the old key's shape", () => {
    const s = memory();
    saveColumns(s, { sidebar: 250, list: 360, collapsed: true });
    expect(JSON.parse(s.m.get(COLUMNS_KEY) ?? "")).toEqual({ width: 250, collapsed: true, list: 360 });
    expect(loadColumns(s)).toEqual({ sidebar: 250, list: 360, collapsed: true });
  });
  test("a malformed saved value reads as the defaults", () => {
    expect(loadColumns(memory({ [COLUMNS_KEY]: "{not json" }))).toEqual(DEFAULTS);
    expect(loadColumns(memory({ [COLUMNS_KEY]: "null" }))).toEqual(DEFAULTS);
    expect(loadColumns(memory({ [COLUMNS_KEY]: JSON.stringify({ width: "wide", list: [] }) }))).toEqual(DEFAULTS);
  });
  test("a blocked store never throws", () => {
    const throwing = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    };
    expect(loadColumns(throwing)).toEqual(DEFAULTS);
    expect(() => saveColumns(throwing, DEFAULTS)).not.toThrow();
    const had = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      get() {
        throw new Error("SecurityError");
      },
    });
    try {
      expect(columnsStore()).toBeNull();
      expect(loadColumns(columnsStore())).toEqual(DEFAULTS);
    } finally {
      if (had) Object.defineProperty(globalThis, "localStorage", had);
      else delete (globalThis as { localStorage?: unknown }).localStorage;
    }
  });
});
