import { describe, expect, test } from "bun:test";
import { COLUMN_DEFAULT, COLUMN_KEY, COLUMN_MAX, COLUMN_MIN, NARROW_BELOW, clampColumn, columnShown, hasColumn, loadColumn, saveColumn, toggleColumn } from "../app/src/shell/column.ts";

/**
 * The list column between the rail and the main pane (plan 013 U3): its width is clamped and kept, its
 * collapse is kept, and below 1100 wide it folds away on its own until asked for.
 */

const memory = (seed: Record<string, string> = {}) => {
  const m = new Map(Object.entries(seed));
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), m };
};

describe("list column: which sections have one", () => {
  test("desk, board, agents and learn; not inbox or settings", () => {
    expect((["desk", "inbox", "board", "agents", "learn", "settings"] as const).filter(hasColumn)).toEqual(["desk", "board", "agents", "learn"]);
  });
});

describe("list column: width", () => {
  test("clamped to the range, rounded, and a junk value falls back to the default", () => {
    expect(clampColumn(100)).toBe(COLUMN_MIN);
    expect(clampColumn(900)).toBe(COLUMN_MAX);
    expect(clampColumn(300.6)).toBe(301);
    expect(clampColumn(Number.NaN)).toBe(COLUMN_DEFAULT);
    expect(COLUMN_MIN).toBe(220);
    expect(COLUMN_MAX).toBe(420);
  });
});

describe("list column: persistence", () => {
  test("nothing stored reads as the default width, open", () => {
    expect(loadColumn(memory())).toEqual({ width: COLUMN_DEFAULT, collapsed: false });
  });
  test("a saved width and collapse come back across a reload, clamped", () => {
    const s = memory();
    saveColumn(s, { width: 333, collapsed: true });
    expect(loadColumn(s)).toEqual({ width: 333, collapsed: true });
    s.setItem(COLUMN_KEY, JSON.stringify({ width: 5000, collapsed: false }));
    expect(loadColumn(s)).toEqual({ width: COLUMN_MAX, collapsed: false });
  });
  test("a corrupt or throwing store reads as the default", () => {
    expect(loadColumn(memory({ [COLUMN_KEY]: "{not json" }))).toEqual({ width: COLUMN_DEFAULT, collapsed: false });
    const throwing = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    };
    expect(loadColumn(throwing)).toEqual({ width: COLUMN_DEFAULT, collapsed: false });
    expect(() => saveColumn(throwing, { width: 300, collapsed: false })).not.toThrow();
  });
});

describe("list column: collapse below 1100 wide", () => {
  const open = { width: 260, collapsed: false };
  test("wide windows follow the saved collapse", () => {
    expect(columnShown(open, 1280, false)).toBe(true);
    expect(columnShown({ ...open, collapsed: true }, 1280, false)).toBe(false);
    expect(columnShown(open, NARROW_BELOW, false)).toBe(true);
  });
  test("narrow windows fold it away until asked, and asking does not touch the saved preference", () => {
    expect(columnShown(open, 1099, false)).toBe(false);
    expect(columnShown(open, 1000, true)).toBe(true);
    const asked = toggleColumn(open, 1000, false);
    expect(asked).toEqual({ pref: open, peek: true });
    expect(toggleColumn(open, 1000, true)).toEqual({ pref: open, peek: false });
  });
  test("on a wide window the toggle flips the saved collapse and drops any peek", () => {
    expect(toggleColumn(open, 1280, false)).toEqual({ pref: { ...open, collapsed: true }, peek: false });
    expect(toggleColumn({ ...open, collapsed: true }, 1280, true)).toEqual({ pref: open, peek: false });
  });
});

describe("list column: the desk column's rows", () => {
  test("the tree's sections as Slack rows: the waiting desk first with its badge, the open desk current", async () => {
    const { createElement } = await import("react");
    const { renderToStaticMarkup } = await import("react-dom/server");
    const { DeskColumn } = await import("../app/src/shell/ListColumn.tsx");
    const desk = (scope: string, title: string, extra = {}) => ({ scope, title, status: "live", agentName: "ira", agentId: "a1", conversationId: scope, model: null, reasoningEffort: null, widgets: 0, active: false, lastActive: "2026-09-23T10:00:00Z", ...extra });
    const desks = [desk("c1", "Loki mobile"), desk("c2", "Taxes", { pinned: true }), desk("c3", "Old", { status: "archived" })];
    const items = [{ id: "c1", agentId: "a1", status: "approval" }];
    const html = renderToStaticMarkup(createElement(DeskColumn, { desks, items, visited: [], current: "c2", onOpen: () => {}, onNew: () => {} } as never));
    expect(html.indexOf("Waiting on you")).toBeLessThan(html.indexOf("Pinned"));
    expect(html).toContain(">1 needs approval</span>");
    expect(html).toMatch(/aria-current="page"[^>]*>(?:(?!<\/button>).)*Taxes/);
    expect(html).not.toContain("Old");
    expect(html).toContain('aria-label="New desk"');
  });
});
