import { describe, expect, test } from "bun:test";
import type { AttentionItem } from "../core/attention/model.ts";
import { stampOf } from "../core/attention/queue.ts";
import {
  COMMIT_FRACTION,
  DRAG_SLOP,
  EMPTY_PASS,
  FLICK_VELOCITY,
  MAX_ROTATION,
  dismiss,
  isHorizontalDrag,
  passTotal,
  pruneDismissed,
  refusedOffset,
  restore,
  revealOpacity,
  rotationFor,
  stackPose,
  summaryLine,
  swipeDecision,
  tally,
  toFront,
  velocityOf,
  visibleQueue,
} from "../app/src/phone/deck.ts";

/**
 * The phone deck's pure half (app/src/phone/deck.ts): when a drag commits and which way, how the
 * card leans and the reveal shows, what a pass adds up to, and which swiped cards stay hidden
 * until they move on. No DOM.
 */

const item = (id: string, over: Partial<AttentionItem> = {}): AttentionItem => ({
  id,
  agentId: "a1",
  agentName: "ira",
  title: id,
  lastMessageAt: "2026-09-07T10:00:00Z",
  archived: false,
  status: "done",
  lastAssistantText: "x",
  lastRole: "assistant",
  pendingApproval: null,
  pendingQuestion: null,
  turns: 0,
  error: null,
  seenAt: null,
  unread: true,
  lastAsk: null,
  score: 0,
  reason: "report",
  runtime: { agent_id: "a1", conversation_id: id },
  ...over,
});

const W = 366; // a 390 phone minus the 12px margins
const plain = { approval: false };
const approval = { approval: true };

describe("swipe decision", () => {
  test("past 40 % of the width: right is seen, left is later", () => {
    expect(swipeDecision(W * COMMIT_FRACTION, W, 0, plain)).toBe("seen");
    expect(swipeDecision(-W * COMMIT_FRACTION, W, 0, plain)).toBe("later");
    expect(swipeDecision(200, W, 0, plain)).toBe("seen");
    expect(swipeDecision(-200, W, 0, plain)).toBe("later");
  });
  test("short of the distance and slow: springs back", () => {
    expect(swipeDecision(W * COMMIT_FRACTION - 1, W, 0, plain)).toBeNull();
    expect(swipeDecision(60, W, 0.2, plain)).toBeNull();
    expect(swipeDecision(-60, W, -0.2, plain)).toBeNull();
    expect(swipeDecision(0, W, 0, plain)).toBeNull();
  });
  test("a fast flick commits short of the distance, in the drag's own direction", () => {
    expect(swipeDecision(40, W, FLICK_VELOCITY, plain)).toBe("seen");
    expect(swipeDecision(-40, W, -FLICK_VELOCITY, plain)).toBe("later");
    // fast but the other way (a flick back toward rest): no
    expect(swipeDecision(40, W, -1.5, plain)).toBeNull();
    // a flick that never cleared the slop is a twitch
    expect(swipeDecision(DRAG_SLOP, W, 2, plain)).toBeNull();
  });
  test("approvals never commit, either way, however far or fast", () => {
    expect(swipeDecision(W, W, 3, approval)).toBeNull();
    expect(swipeDecision(-W, W, -3, approval)).toBeNull();
    expect(swipeDecision(W * COMMIT_FRACTION, W, 0, approval)).toBeNull();
  });
  test("a missing width cannot commit", () => {
    expect(swipeDecision(500, 0, 0, plain)).toBeNull();
    expect(swipeDecision(500, Number.NaN, 0, plain)).toBeNull();
  });
});

describe("drag start", () => {
  test("sideways past the slop is a drag; up-and-down or tiny moves are not", () => {
    expect(isHorizontalDrag(9, 2)).toBe(true);
    expect(isHorizontalDrag(-9, 2)).toBe(true);
    expect(isHorizontalDrag(8, 0)).toBe(false); // at the slop, not past it
    expect(isHorizontalDrag(20, 25)).toBe(false); // more vertical than horizontal: the thread scrolls
    expect(isHorizontalDrag(3, 1)).toBe(false); // a tap
  });
});

describe("lean and reveal", () => {
  test("rotation is 8° at the commit distance and clamped beyond", () => {
    expect(rotationFor(0, W)).toBe(0);
    expect(rotationFor(W * COMMIT_FRACTION, W)).toBeCloseTo(MAX_ROTATION);
    expect(rotationFor(-W * COMMIT_FRACTION, W)).toBeCloseTo(-MAX_ROTATION);
    expect(rotationFor(W * COMMIT_FRACTION * 0.5, W)).toBeCloseTo(MAX_ROTATION / 2);
    expect(rotationFor(W * 3, W)).toBe(MAX_ROTATION);
    expect(rotationFor(-W * 3, W)).toBe(-MAX_ROTATION);
    expect(rotationFor(100, 0)).toBe(0);
  });
  test("reveal opacity follows the distance, full at the commit point, never past 1", () => {
    expect(revealOpacity(0, W)).toBe(0);
    expect(revealOpacity(W * COMMIT_FRACTION * 0.25, W)).toBeCloseTo(0.25);
    expect(revealOpacity(-W * COMMIT_FRACTION * 0.25, W)).toBeCloseTo(0.25);
    expect(revealOpacity(W * COMMIT_FRACTION, W)).toBe(1);
    expect(revealOpacity(W, W)).toBe(1);
    expect(revealOpacity(100, 0)).toBe(0);
  });
  test("an approval follows the finger a quarter of the way, at most 40px", () => {
    expect(refusedOffset(40)).toBe(10);
    expect(refusedOffset(-40)).toBe(-10);
    expect(refusedOffset(400)).toBe(40);
    expect(refusedOffset(-400)).toBe(-40);
  });
  test("the stack behind: 0.96 / 8px / dimmer, then 0.92 / 16px / dimmer still", () => {
    expect(stackPose(0)).toEqual({ scale: 1, offsetY: 0, opacity: 1 });
    expect(stackPose(1)).toEqual({ scale: 0.97, offsetY: 6, opacity: 0.7 });
    expect(stackPose(2)).toEqual({ scale: 0.94, offsetY: 12, opacity: 0.45 });
    expect(stackPose(5)).toEqual(stackPose(2));
  });
});

describe("velocity", () => {
  test("px per ms over the last stretch of samples", () => {
    expect(velocityOf([])).toBe(0);
    expect(velocityOf([{ x: 0, t: 0 }])).toBe(0);
    expect(velocityOf([{ x: 0, t: 0 }, { x: 60, t: 100 }])).toBeCloseTo(0.6);
    // uses the sample at least 60 ms back, not the whole drag: a slow start then a flick
    const samples = [
      { x: 0, t: 0 },
      { x: 10, t: 300 },
      { x: 20, t: 600 },
      { x: 30, t: 640 },
      { x: 90, t: 680 },
    ];
    expect(velocityOf(samples)).toBeCloseTo((90 - 20) / 80);
  });
});

describe("pass summary", () => {
  test("tallies each way off the deck and prints only what happened", () => {
    let s = EMPTY_PASS;
    expect(summaryLine(s)).toBe("");
    s = tally(s, "seen");
    s = tally(s, "seen");
    s = tally(s, "later");
    s = tally(s, "approve");
    expect(s).toEqual({ seen: 2, later: 1, approved: 1, denied: 0 });
    expect(summaryLine(s)).toBe("2 seen · 1 deferred · 1 approved");
    expect(passTotal(s)).toBe(4);
    s = tally(s, "deny");
    expect(summaryLine(s)).toBe("2 seen · 1 deferred · 1 approved · 1 denied");
  });
  test("undo takes one back and never goes below zero", () => {
    let s = tally(EMPTY_PASS, "seen");
    s = tally(s, "seen", -1);
    expect(s.seen).toBe(0);
    s = tally(s, "later", -1);
    expect(s.later).toBe(0);
  });
});

describe("dismissed unless the stamp changed", () => {
  test("a swiped card stays out while its content holds, even if the list re-sorts or timestamps move", () => {
    const a = item("a"), b = item("b");
    const d = dismiss(new Map(), a);
    expect(visibleQueue([a, b], d).map((i) => i.id)).toEqual(["b"]);
    expect(visibleQueue([b, a], d).map((i) => i.id)).toEqual(["b"]);
    const bumped = item("a", { lastMessageAt: "2026-09-07T10:05:00Z" });
    expect(stampOf(bumped)).toBe(stampOf(a));
    expect(visibleQueue([bumped, b], d).map((i) => i.id)).toEqual(["b"]);
  });
  test("a new reply, a new approval or a finished turn brings it back", () => {
    const a = item("a");
    const d = dismiss(new Map(), a);
    expect(visibleQueue([item("a", { lastAssistantText: "something new" })], d).map((i) => i.id)).toEqual(["a"]);
    expect(visibleQueue([item("a", { status: "approval", pendingApproval: { requestId: "r1", toolName: "Bash", input: "ls", at: "2026-09-07T10:01:00Z" } })], d).map((i) => i.id)).toEqual(["a"]);
    expect(visibleQueue([item("a", { turns: 1 })], d).map((i) => i.id)).toEqual(["a"]);
  });
  test("undo restores; pruning drops entries the live list has outgrown", () => {
    const a = item("a"), b = item("b");
    let d = dismiss(dismiss(new Map(), a), b);
    expect(visibleQueue([a, b], d)).toEqual([]);
    d = restore(d, a);
    expect(visibleQueue([a, b], d).map((i) => i.id)).toEqual(["a"]);
    // b moved on, a is gone from the list: nothing left to remember
    expect(pruneDismissed(d, [item("b", { turns: 2 })]).size).toBe(0);
    // b unchanged and still actionable (the round trip has not landed): kept
    expect(pruneDismissed(d, [b]).size).toBe(1);
  });
  test("an entry only bridges the round trip: once the snooze or the seen marker lands, it goes", () => {
    const b = item("b");
    const d = dismiss(new Map(), b);
    const snooze = { skips: 1, until: "2026-09-07T10:05:00Z", stamp: stampOf(b), at: "2026-09-07T10:00:00Z" };
    // the snooze arrived: the queue hides b by itself; forget the entry so an unsnooze shows it again
    expect(pruneDismissed(d, [item("b", { snooze })]).size).toBe(0);
    expect(visibleQueue([b], pruneDismissed(d, [item("b", { snooze })])).map((i) => i.id)).toEqual(["b"]);
    // marked seen: idle now, same thing
    expect(pruneDismissed(d, [item("b", { status: "idle", unread: false })]).size).toBe(0);
  });
});

describe("the top card stays on top", () => {
  test("the pinned id comes first; the rest keep their order; an unknown or null pin changes nothing", () => {
    const a = item("a"), b = item("b"), c = item("c");
    expect(toFront([a, b, c], "a1/c").map((i) => i.id)).toEqual(["c", "a", "b"]);
    expect(toFront([a, b, c], "a1/a").map((i) => i.id)).toEqual(["a", "b", "c"]);
    expect(toFront([a, b, c], null).map((i) => i.id)).toEqual(["a", "b", "c"]);
    expect(toFront([a, b, c], "a1/zz").map((i) => i.id)).toEqual(["a", "b", "c"]);
  });
});
