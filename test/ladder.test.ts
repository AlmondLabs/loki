import { describe, expect, test } from "bun:test";
import { DEFAULT_LADDER, LADDER_RANGE, MAX_SNOOZE_MS, clampLadder, formatGap, ladderSteps, snoozeGapMs } from "../core/attention/ladder.ts";

/** The "later" ladder (core/attention/ladder.ts): first · growth^(n−1) minutes, capped at a day, two clamped knobs. */
describe("the later ladder", () => {
  test("defaults: 10 minutes, times three, so 10m · 30m · 1h 30m · 4h 30m · 13h 30m · 1d", () => {
    expect(DEFAULT_LADDER).toEqual({ firstMinutes: 10, growth: 3 });
    expect(ladderSteps().map(formatGap)).toEqual(["10m", "30m", "1h 30m", "4h 30m", "13h 30m", "1d"]);
    expect(snoozeGapMs(7)).toBe(MAX_SNOOZE_MS);
    expect(snoozeGapMs(0)).toBe(10 * 60_000); // a zeroth deferral is the first
  });

  test("the steps stop at the cap, and a growth of one keeps every step the same", () => {
    expect(ladderSteps({ firstMinutes: 10, growth: 10 }).map(formatGap)).toEqual(["10m", "1h 40m", "16h 40m", "1d"]);
    expect(ladderSteps({ firstMinutes: 15, growth: 1 }, 4).map(formatGap)).toEqual(["15m", "15m", "15m", "15m"]);
    expect(ladderSteps({ firstMinutes: 1440, growth: 3 })).toEqual([MAX_SNOOZE_MS]);
  });

  test("clamping: each knob within its range, a missing one kept from the base, nonsense falls to the default", () => {
    expect(clampLadder({ firstMinutes: 25 })).toEqual({ firstMinutes: 25, growth: 3 });
    expect(clampLadder({ growth: 2 }, { firstMinutes: 25, growth: 3 })).toEqual({ firstMinutes: 25, growth: 2 });
    expect(clampLadder({ firstMinutes: 0, growth: 99 })).toEqual({ firstMinutes: LADDER_RANGE.firstMinutes.min, growth: LADDER_RANGE.growth.max });
    expect(clampLadder({ firstMinutes: "12", growth: "abc" })).toEqual({ firstMinutes: 12, growth: 3 });
    expect(clampLadder(null)).toEqual(DEFAULT_LADDER);
    expect(clampLadder({ firstMinutes: undefined, growth: undefined }, { firstMinutes: 7, growth: 4 })).toEqual({ firstMinutes: 7, growth: 4 });
  });

  test("formatGap says it the way people do", () => {
    expect([1, 59, 60, 61, 90, 120, 810, 1440, 2880].map((m) => formatGap(m * 60_000))).toEqual(["1m", "59m", "1h", "1h 1m", "1h 30m", "2h", "13h 30m", "1d", "2d"]);
  });
});
