import { describe, expect, test } from "vitest";
import { afterScroll, keepReading, putBackAfterReveal } from "../app/src/chat/use-transcript-scroll.ts";

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
    expect(was?.offset).toBe(-50);
    t.rows[0].h += 160;
    const now = keepReading(t.el, was);
    expect(t.raw.scrollTop).toBe(410);
    expect(now?.offset).toBe(-50);
  });

  test("the reader's own scroll is not undone, even when a picture loads in the same moment", () => {
    const t = thread([100, 100, 100, 100], 250);
    const was = keepReading(t.el, null);
    t.raw.scrollTop = 200;
    t.rows[0].h += 160;
    keepReading(t.el, was);
    expect(t.raw.scrollTop).toBe(360);
  });

  test("a row that grows below the one being read changes nothing", () => {
    const t = thread([100, 100, 100, 100], 250);
    const was = keepReading(t.el, null);
    t.rows[3].h += 160;
    keepReading(t.el, was);
    expect(t.raw.scrollTop).toBe(250);
  });
});

describe("the phone's thread keeps your place once when older rows come in above", () => {
  test("the scroll the reveal makes is not taken for content moving, so the offset moves once", () => {
    const t = thread([100, 100, 100, 100], 250);
    const reading = keepReading(t.el, null);
    t.rows.unshift({ h: 400, isConnected: true });
    Object.defineProperty(t.raw, "scrollHeight", { get: () => t.rows.reduce((n, r) => n + r.h, 0), configurable: true });
    const now = putBackAfterReveal(t.el, { top: 250, height: 400 });
    expect(t.raw.scrollTop).toBe(650);
    keepReading(t.el, now);
    expect(t.raw.scrollTop).toBe(650);
    expect(reading?.offset).toBe(now?.offset);
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
