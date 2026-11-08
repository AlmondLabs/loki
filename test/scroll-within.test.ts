import { describe, expect, test } from "vitest";
import { scrollWithin } from "../app/src/shared/scroll-within.ts";

/** A scrolling box 400 high at y 100 with a 1-pixel border, and a row 40 high at `rowTop` in its content. */
function boxAndRow(rowTop: number, scrollTop = 0) {
  const box = { scrollTop, clientHeight: 400, clientTop: 1, getBoundingClientRect: () => ({ top: 100 }) as DOMRect };
  const row = { getBoundingClientRect: () => ({ top: 100 + 1 + rowTop - box.scrollTop, height: 40 }) as DOMRect };
  return { box, row };
}

describe("a card scrolls its own thread and nothing above it", () => {
  test("the row lands in the middle of the box", () => {
    const { box, row } = boxAndRow(1000, 120);
    scrollWithin(box, row, "center");
    expect(box.scrollTop).toBe(1000 + 20 - 200);
  });

  test("the row lands at the end of the box", () => {
    const { box, row } = boxAndRow(1000);
    scrollWithin(box, row, "end");
    expect(box.scrollTop).toBe(1040 - 400);
  });

  test("a row near the top leaves the box at its top", () => {
    const { box, row } = boxAndRow(50, 300);
    scrollWithin(box, row, "center");
    expect(box.scrollTop).toBe(0);
  });
});
