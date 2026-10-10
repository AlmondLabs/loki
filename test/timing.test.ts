import { describe, expect, test } from "vitest";
import { covered, median, turnTimings } from "../daemon/timing.ts";

describe("turn timings", () => {
  test("a turn with a tool splits into model, tool and harness time, and the gaps around them", () => {
    // send at 0; request reaches the model at 100; first token 400; response ends 1000 with a tool call;
    // the tool runs 1050–1500; the next request starts 1600 and ends 2600.
    const t = turnTimings({
      sentAt: 0,
      firstOutputAt: 400,
      models: [{ start: 100, end: 1000 }, { start: 1600, end: 2600 }],
      tools: [{ start: 1050, end: 1500 }],
    });
    expect(t).toEqual({
      ttftMs: 400,
      totalMs: 2600,
      modelMs: 1900,
      toolMs: 450,
      overheadMs: 250, // 100 before the first request, 50 before the tool, 100 after it
      beforeFirstRequestMs: 100,
      afterToolMs: [100],
    });
  });

  test("a turn without tools: overhead is the turn minus the model's time", () => {
    const t = turnTimings({ sentAt: 1000, firstOutputAt: 1300, models: [{ start: 1050, end: 2000 }], tools: [] });
    expect(t.toolMs).toBe(0);
    expect(t.afterToolMs).toEqual([]);
    expect(t.overheadMs).toBe(50);
    expect(t.totalMs).toBe(1000);
  });

  test("tools that run in parallel count once, and each result's gap is to the next request", () => {
    const t = turnTimings({
      sentAt: 0,
      firstOutputAt: 200,
      models: [{ start: 0, end: 500 }, { start: 900, end: 1200 }],
      tools: [{ start: 500, end: 800 }, { start: 500, end: 700 }],
    });
    expect(t.toolMs).toBe(300);
    expect(t.afterToolMs).toEqual([100, 200]);
    expect(t.overheadMs).toBe(100);
  });

  test("no output at all: no time to first token, and the turn ends where it began", () => {
    expect(turnTimings({ sentAt: 5, firstOutputAt: null, models: [], tools: [] })).toMatchObject({ ttftMs: null, totalMs: 0, beforeFirstRequestMs: null });
  });

  test("the turn ends when the client saw it end, and the wait after the last response counts as the harness's", () => {
    const t = turnTimings({ sentAt: 0, firstOutputAt: 100, models: [{ start: 20, end: 500 }], tools: [], endAt: 650 });
    expect(t.totalMs).toBe(650);
    expect(t.overheadMs).toBe(170);
  });

  test("covered joins overlapping spans and ignores empty ones", () => {
    expect(covered([{ start: 0, end: 10 }, { start: 5, end: 20 }, { start: 30, end: 40 }, { start: 50, end: 50 }])).toBe(30);
  });

  test("median of odd and even counts, and of none", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(median([])).toBeNull();
  });
});
