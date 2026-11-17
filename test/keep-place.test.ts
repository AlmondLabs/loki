import { describe, expect, test } from "vitest";
import { holdPlace, placeAfterReveal } from "../app/src/item/use-keep-place.ts";

/**
 * The desktop thread as layout numbers: its rows' heights in order, its offset, and whether MessageScroller marks it as
 * away from the end (`data-scrollable` holding "end", which it sets only while it is not following the bottom). Each row
 * is one element for as long as it is mounted, so a row put in again (a turn drawn under a new key) is a new element.
 */
function thread(heights: number[], scrollTop: number, away = true) {
  const view = { top: 100 };
  interface Row {
    h: number;
    node: { isConnected: boolean; getBoundingClientRect: () => { top: number; bottom: number } };
  }
  const rows: Row[] = [];
  const contentTop = (row: Row) => {
    let top = 0;
    for (const r of rows) {
      if (r === row) return top;
      top += r.h;
    }
    return top;
  };
  const make = (h: number): Row => {
    const row: Row = {
      h,
      node: {
        isConnected: true,
        getBoundingClientRect: () => ({ top: view.top + contentTop(row) - el.scrollTop, bottom: view.top + contentTop(row) + row.h - el.scrollTop }),
      },
    };
    return row;
  };
  const el = {
    scrollTop,
    away,
    get scrollHeight() {
      return rows.reduce((n, r) => n + r.h, 0);
    },
    getAttribute: (name: string) => (name === "data-scrollable" ? (el.away ? "start end" : "start") : null),
    getBoundingClientRect: () => ({ top: view.top }),
    querySelectorAll: () => rows.filter((r) => r.node.isConnected).map((r) => r.node),
  };
  rows.push(...heights.map(make));
  return {
    el: el as unknown as HTMLElement,
    raw: el,
    rows,
    reveal: (added: number[]) => rows.unshift(...added.map(make)),
    remount: (at: number, h: number) => {
      rows[at].node.isConnected = false;
      rows[at] = make(h);
    },
  };
}

describe("the desktop thread keeps your place when older rows come in above (WebKit has no scroll anchoring)", () => {
  test("revealed rows above move the offset by their height, and the reader sees the same row", () => {
    const t = thread([100, 100, 100, 100], 250);
    const reading = holdPlace(t.el, null);
    const before = { top: t.raw.scrollTop, height: t.raw.scrollHeight };
    t.reveal([120, 80, 200]);
    const now = placeAfterReveal(t.el, before, reading);
    expect(t.raw.scrollTop).toBe(650);
    expect(now?.offset).toBe(-50);
  });

  test("the scroll the reveal makes is not taken for content moving, so the offset moves once", () => {
    const t = thread([100, 100, 100, 100], 250);
    const reading = holdPlace(t.el, null);
    const before = { top: t.raw.scrollTop, height: t.raw.scrollHeight };
    t.reveal([400]);
    const now = placeAfterReveal(t.el, before, reading);
    holdPlace(t.el, now);
    expect(t.raw.scrollTop).toBe(650);
  });

  test("a row being read that is drawn again under a new key falls back to how much the thread grew", () => {
    const t = thread([300, 100, 100], 50);
    const reading = holdPlace(t.el, null);
    const before = { top: t.raw.scrollTop, height: t.raw.scrollHeight };
    t.remount(0, 500);
    placeAfterReveal(t.el, before, reading);
    expect(t.raw.scrollTop).toBe(250);
  });

  test("rows find mounts above are not put back, so find's own scroll to the match stays where find put it", () => {
    const t = thread([100, 100, 100, 100], 250);
    const reading = holdPlace(t.el, null);
    t.reveal([400]);
    const now = placeAfterReveal(t.el, null, reading);
    expect(t.raw.scrollTop).toBe(250);
    t.raw.scrollTop = 0;
    holdPlace(t.el, now);
    expect(t.raw.scrollTop).toBe(0);
  });

  test("following the bottom, a reveal leaves the offset to MessageScroller", () => {
    const t = thread([100, 100], 0, false);
    const before = { top: 0, height: t.raw.scrollHeight };
    t.reveal([100]);
    placeAfterReveal(t.el, before, holdPlace(t.el, null));
    expect(t.raw.scrollTop).toBe(0);
  });
});

describe("the desktop thread keeps your place when something above changes height", () => {
  test("scrolled up, a picture loading above the row being read moves the offset by its height", () => {
    const t = thread([100, 100, 100, 100], 250);
    const reading = holdPlace(t.el, null);
    t.rows[0].h += 160;
    holdPlace(t.el, reading);
    expect(t.raw.scrollTop).toBe(410);
  });

  test("following the bottom, a change above is left to MessageScroller, which keeps the bottom in view", () => {
    const t = thread([100, 100, 100, 100], 250, false);
    const reading = holdPlace(t.el, null);
    t.rows[0].h += 160;
    holdPlace(t.el, reading);
    expect(t.raw.scrollTop).toBe(250);
  });
});
