import { describe, expect, test } from "vitest";
import { fitLeft } from "../app/src/shared/caret-offset.ts";

describe("a type-ahead list's place under the caret", () => {
  test("starts where the word starts when there is room", () => {
    expect(fitLeft(120, 240, 600)).toBe(120);
  });

  test("stops at the box's trailing edge rather than hanging past it", () => {
    expect(fitLeft(500, 240, 600)).toBe(360);
  });

  test("never starts before the box, even when the list is wider than it", () => {
    expect(fitLeft(-8, 240, 600)).toBe(0);
    expect(fitLeft(40, 700, 600)).toBe(0);
  });
});
