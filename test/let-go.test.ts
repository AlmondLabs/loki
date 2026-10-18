import { describe, expect, test } from "vitest";
import { DECELERATION, project, releaseCommits, releaseVelocity } from "../app/src/kit/let-go.ts";

describe("speed at letting go", () => {
  test("px per second over the last stretch of samples", () => {
    expect(releaseVelocity([], 0)).toBe(0);
    expect(releaseVelocity([{ at: 0, t: 0 }], 0)).toBe(0);
    expect(
      releaseVelocity(
        [
          { at: 0, t: 0 },
          { at: 60, t: 100 },
        ],
        100,
      ),
    ).toBeCloseTo(600);
    // uses the sample at least 60 ms back, not the whole drag: a slow start then a flick
    const samples = [
      { at: 0, t: 0 },
      { at: 10, t: 300 },
      { at: 20, t: 600 },
      { at: 30, t: 640 },
      { at: 90, t: 680 },
    ];
    expect(releaseVelocity(samples, 690)).toBeCloseTo(((90 - 20) / 80) * 1000);
  });

  test("a finger that stopped and held before letting go was not moving", () => {
    const flick = [
      { at: 0, t: 0 },
      { at: 80, t: 40 },
    ];
    expect(releaseVelocity(flick, 45)).toBeCloseTo(2000);
    expect(releaseVelocity(flick, 40 + 50)).toBe(0);
    expect(releaseVelocity(flick, 40 + 400)).toBe(0);
  });
});

describe("projection", () => {
  test("still lands where it is; faster lands further, either way", () => {
    expect(project(0)).toBe(0);
    expect(project(1000)).toBeCloseTo(DECELERATION / (1 - DECELERATION));
    expect(project(-1000)).toBeCloseTo(-project(1000));
    expect(project(2000)).toBeCloseTo(2 * project(1000));
  });

  test("a release commits by where it was going, past the slop", () => {
    expect(releaseCommits(150, 0, 120, 8)).toBe(true);
    expect(releaseCommits(100, 0, 120, 8)).toBe(false);
    expect(releaseCommits(40, 900, 120, 8)).toBe(true);
    // past the line but thrown back: stays
    expect(releaseCommits(150, -1500, 120, 8)).toBe(false);
    // inside the slop, however fast: a tap
    expect(releaseCommits(6, 5000, 120, 8)).toBe(false);
  });
});
