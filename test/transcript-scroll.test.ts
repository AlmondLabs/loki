import { describe, expect, test } from "vitest";
import { afterScroll, keepReading } from "../app/src/chat/use-transcript-scroll.ts";

/**
 * A thread and its rows as layout numbers: each row's top in the content, its height, and the thread's offset. The
 * rows' screen positions follow from the offset, as the browser's would.
 */
function thread(heights: number[], scrollTop: number) {
  const view = { top: 100 };
  const rows = heights.map((h) => ({ h, isConnected: true }));
  const contentTop = (i: number) => rows.slice(0, i).reduce((n, r) => n + r.h, 0);
  const el = {
    scrollTop,
    getBoundingClientRect: () => ({ top: view.top }),
    querySelectorAll: () =>
      rows.map((r, i) => ({
        isConnected: true,
        getBoundingClientRect: () => ({ top: view.top + contentTop(i) - el.scrollTop, bottom: view.top + contentTop(i) + r.h - el.scrollTop }),
      })),
  };
  return { el: el as unknown as HTMLElement, rows, raw: el };
}

describe("the chat keeps the row being read in place (WebKit has no scroll anchoring)", () => {
  test("a picture loading above the row being read moves the offset by its height", () => {
    const t = thread([100, 100, 100, 100], 250);
    const was = keepReading(t.el, null);
    expect(was?.offset).toBe(-50); // the third row, half above the top
    t.rows[0].h += 160; // the first row's picture loads
    const now = keepReading(t.el, was);
    expect(t.raw.scrollTop).toBe(410);
    expect(now?.offset).toBe(-50);
  });

  test("the reader's own scroll is not undone, even when a picture loads in the same moment", () => {
    const t = thread([100, 100, 100, 100], 250);
    const was = keepReading(t.el, null);
    t.raw.scrollTop = 200; // the reader scrolls up 50
    t.rows[0].h += 160; // and a picture above loads before the scroll is handled
    keepReading(t.el, was);
    expect(t.raw.scrollTop).toBe(360); // the 50 kept, the 160 put back
  });

  test("a row that grows below the one being read changes nothing", () => {
    const t = thread([100, 100, 100, 100], 250);
    const was = keepReading(t.el, null);
    t.rows[3].h += 160;
    keepReading(t.el, was);
    expect(t.raw.scrollTop).toBe(250);
  });
});

describe("the chat leaves the bottom only when the reader scrolls up", () => {
  test("near the bottom it follows", () => {
    expect(afterScroll(10, false, 500, 600).pinned).toBe(true);
  });
  test("following, a scroll that lands short of a bottom that grew again goes back down", () => {
    expect(afterScroll(2000, true, 4747, 4440)).toEqual({ pinned: true, stick: true });
  });
  test("scrolling up slowly near the bottom is never pulled back", () => {
    expect(afterScroll(4, true, 4436, 4440)).toEqual({ pinned: true, stick: false });
    expect(afterScroll(30, true, 4410, 4436)).toEqual({ pinned: true, stick: false });
  });
  test("far enough up it stops following, and once left it does not follow from far away", () => {
    expect(afterScroll(300, true, 4400, 4440).pinned).toBe(false);
    expect(afterScroll(300, false, 4500, 4440).pinned).toBe(false);
  });
});
