import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SPRINGS, settleTime, spring, springAt, springTokens } from "../app/src/kit/spring.ts";

const tokens = readFileSync(join(import.meta.dir, "..", "app", "src", "kit", "tokens.css"), "utf8");
const points = (easing: string) => easing.slice("linear(".length, -1).split(", ").map(Number);

describe("springs", () => {
  test("tokens.css carries exactly what kit/spring.ts computes (run bun scripts/springs.ts)", () => {
    expect(tokens).toContain(springTokens());
  });

  test("every preset starts at 0, ends at rest on 1, and looks settled by ~300 ms", () => {
    for (const s of Object.values(SPRINGS)) {
      expect(springAt(s, 0)).toBeCloseTo(0, 6);
      expect(Math.abs(1 - springAt(s, settleTime(s)))).toBeLessThan(0.001);
      expect(springAt(s, 0.3)).toBeGreaterThan(0.96);
    }
  });

  test("smooth never overshoots; snappy barely does; bouncy does, but less than iOS's bouncy", () => {
    const peak = (name: keyof typeof SPRINGS) => Math.max(...points(spring(name).easing));
    expect(peak("smooth")).toBeLessThanOrEqual(1);
    expect(peak("snappy")).toBeLessThan(1.01);
    expect(peak("bouncy")).toBeGreaterThan(1.02);
    expect(peak("bouncy")).toBeLessThan(1.046); // SwiftUI's .bouncy (bounce 0.3) peaks near 4.6%
  });

  test("a start velocity carries into the curve: a flick toward the target starts steeper", () => {
    const still = points(spring("snappy").easing);
    const flicked = points(spring("snappy", 4).easing);
    expect(flicked[1]).toBeGreaterThan(still[1]);
    expect(flicked.at(-1)).toBe(1);
  });

  test("a wild velocity is clamped, so the curve stays on screen", () => {
    expect(spring("smooth", 500).easing).toBe(spring("smooth", 8).easing);
  });

  test("durations are whole milliseconds and the curve has enough points to read as one", () => {
    for (const name of Object.keys(SPRINGS) as (keyof typeof SPRINGS)[]) {
      const { easing, ms } = spring(name);
      expect(Number.isInteger(ms)).toBe(true);
      expect(points(easing).length).toBeGreaterThanOrEqual(21);
    }
  });
});
