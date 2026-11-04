import { describe, expect, test } from "vitest";
import { REFILL_BATCH, advanceRefill, firstRefill, refillWindow, type RefillCursor } from "../core/account-refill.ts";
import { must } from "./fixtures/must.ts";

const DAY = 24 * 3600 * 1000;
const ANCHOR = "2026-11-04T09:00:00.000Z";
const daysBack = (d: number) => new Date(Date.parse(ANCHOR) - d * DAY).toISOString();

/** Walk the windows of an account whose every window comes back not full and not empty. */
function walk(steps: number): Array<{ after: string; before: string }> {
  let cursor = firstRefill(new Date(ANCHOR));
  const out: Array<{ after: string; before: string }> = [];
  for (let i = 0; i < steps; i++) {
    const w = must(refillWindow(cursor, 0), "a window");
    out.push({ after: w.after, before: w.before });
    cursor = advanceRefill(cursor, w, { kind: "done" });
  }
  return out;
}

describe("the batches of older unread mail (R8, KTD13)", () => {
  test("the first window is the last 3 days, all of it; then 7, 14 and 30 days back, then 30 days more each time", () => {
    const first = must(refillWindow(firstRefill(new Date(ANCHOR)), 0), "the first window");
    expect(first).toEqual({ after: daysBack(3), before: ANCHOR, limit: null });
    expect(walk(7)).toEqual([
      { after: daysBack(3), before: ANCHOR },
      { after: daysBack(7), before: daysBack(3) },
      { after: daysBack(14), before: daysBack(7) },
      { after: daysBack(30), before: daysBack(14) },
      { after: daysBack(60), before: daysBack(30) },
      { after: daysBack(90), before: daysBack(60) },
      { after: daysBack(120), before: daysBack(90) },
    ]);
  });

  test("a later batch holds at most 20 threads", () => {
    const cursor = advanceRefill(firstRefill(new Date(ANCHOR)), must(refillWindow(firstRefill(new Date(ANCHOR)), 0), "w"), { kind: "done" });
    expect(must(refillWindow(cursor, 0), "the second window").limit).toBe(REFILL_BATCH);
    expect(REFILL_BATCH).toBe(20);
  });

  test("no batch comes while the account has an open card, resting ones included", () => {
    const cursor = advanceRefill(firstRefill(new Date(ANCHOR)), must(refillWindow(firstRefill(new Date(ANCHOR)), 0), "w"), { kind: "done" });
    expect(refillWindow(cursor, 1)).toBeNull();
    expect(refillWindow(cursor, 0)).not.toBeNull();
  });

  test("a full batch stops at its oldest thread, and the next batch goes on from there in the same window", () => {
    let cursor: RefillCursor = { anchor: ANCHOR, before: daysBack(3), days: 3, exhausted: false };
    const w = must(refillWindow(cursor, 0), "w");
    cursor = advanceRefill(cursor, w, { kind: "full", oldest_at: daysBack(5) });
    expect(refillWindow(cursor, 0)).toEqual({ after: daysBack(7), before: daysBack(5), limit: 20 });
  });

  test("an empty window skips to the window holding the newest older unread mail; none older means nothing is left", () => {
    let cursor: RefillCursor = { anchor: ANCHOR, before: daysBack(3), days: 3, exhausted: false };
    const w = must(refillWindow(cursor, 0), "w");
    const older = daysBack(75);
    cursor = advanceRefill(cursor, w, { kind: "empty", newest_older_at: older });
    const next = must(refillWindow(cursor, 0), "the window with older mail");
    expect(next.after).toBe(daysBack(90));
    expect(Date.parse(next.before)).toBeGreaterThan(Date.parse(older));
    expect(Date.parse(next.before)).toBeLessThanOrEqual(Date.parse(daysBack(60)));
    cursor = advanceRefill(cursor, next, { kind: "empty", newest_older_at: null });
    expect(cursor.exhausted).toBe(true);
    expect(refillWindow(cursor, 0)).toBeNull();
  });
});
