import { describe, expect, test } from "vitest";
import { createActiveClock } from "../core/attention/activeClock.ts";

describe("active clock", () => {
  test("runs only while active: time with the window behind or hidden is not counted", () => {
    let t = 1000;
    const clock = createActiveClock(() => t);
    t += 30_000;
    expect(clock.now()).toBe(30_000);
    clock.set(false);
    t += 3 * 3_600_000; // three hours away
    expect(clock.now()).toBe(30_000);
    expect(clock.running()).toBe(false);
    clock.set(true);
    t += 5_000;
    expect(clock.now()).toBe(35_000);
  });
  test("starting stopped counts nothing until activated; repeated sets change nothing", () => {
    let t = 0;
    const clock = createActiveClock(() => t, false);
    t += 10_000;
    expect(clock.now()).toBe(0);
    clock.set(true);
    clock.set(true);
    t += 2_000;
    clock.set(false);
    clock.set(false);
    t += 2_000;
    expect(clock.now()).toBe(2_000);
  });
});
