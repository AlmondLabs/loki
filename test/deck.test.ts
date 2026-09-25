import { describe, expect, test } from "bun:test";
import type { AttentionItem } from "../core/attention/model.ts";
import { stampOf } from "../core/attention/queue.ts";
import {
  COMMIT_FRACTION,
  DRAG_SLOP,
  EMPTY_DECK,
  EMPTY_PASS,
  FLICK_VELOCITY,
  MAX_ROTATION,
  canCommit,
  cardNotice,
  commitCard,
  dayLabel,
  deckQueue,
  dismiss,
  holdCard,
  isHorizontalDrag,
  passTotal,
  pruneDismissed,
  reconcileDeck,
  refusedOffset,
  restore,
  reviewAnnouncement,
  revealOpacity,
  rotationFor,
  stackPose,
  summaryLine,
  swipeDecision,
  tally,
  toFront,
  undoCard,
  unreadBoundary,
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
  viewedAt: null,
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
    expect(summaryLine(s)).toBe("2 marked as read · 1 for later · 1 approved");
    expect(passTotal(s)).toBe(4);
    s = tally(s, "deny");
    expect(summaryLine(s)).toBe("2 marked as read · 1 for later · 1 approved · 1 denied");
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

/**
 * The deck as one state (U4): the pass a person is in the middle of — what went, what is on top, the card
 * held after a reply, the tally — as pure steps, so Later, Mark as done, undo and the approval refusal are
 * checked here rather than in a browser.
 */
describe("the review pass: Later, Mark as done, undo, approvals", () => {
  const three = () => [item("a"), item("b"), item("c")];
  const ask = item("q", { status: "approval", pendingApproval: { requestId: "r1", toolName: "Bash", input: "ls", at: "2026-09-07T10:01:00Z" } });

  test("Later advances once: the next card is on top and one fewer is left", () => {
    const items = three();
    let s = EMPTY_DECK;
    expect(deckQueue(items, s).map((i) => i.id)).toEqual(["a", "b", "c"]);
    s = commitCard(s, items[0], "later");
    expect(deckQueue(items, s).map((i) => i.id)).toEqual(["b", "c"]);
    expect(s.pass).toEqual({ ...EMPTY_PASS, later: 1 });
  });
  test("Mark as done advances once, and undo puts the same card back on top with the count restored", () => {
    const items = three();
    let s = commitCard(EMPTY_DECK, items[0], "seen");
    expect(deckQueue(items, s)).toHaveLength(2);
    s = undoCard(s, items[0], "seen");
    expect(deckQueue(items, s).map((i) => i.id)).toEqual(["a", "b", "c"]);
    expect(passTotal(s.pass)).toBe(0);
  });
  test("an undone card returns on top even when the list has re-sorted under it", () => {
    const [a, b, c] = three();
    let s = commitCard(EMPTY_DECK, b, "later");
    s = undoCard(s, b, "later");
    expect(deckQueue([a, b, c], s)[0].id).toBe("b");
  });
  test("an approval refuses Later and Mark as done: the state does not move", () => {
    const s = EMPTY_DECK;
    expect(canCommit(ask, "later")).toBe(false);
    expect(canCommit(ask, "seen")).toBe(false);
    expect(commitCard(s, ask, "later")).toBe(s);
    expect(commitCard(s, ask, "seen")).toBe(s);
    expect(deckQueue([ask], s).map((i) => i.id)).toEqual(["q"]);
  });
  test("only approve or deny takes an approval off; a plain card cannot be approved", () => {
    expect(canCommit(ask, "approve")).toBe(true);
    expect(canCommit(ask, "deny")).toBe(true);
    expect(canCommit(item("a"), "approve")).toBe(false);
    const s = commitCard(EMPTY_DECK, ask, "approve");
    expect(deckQueue([ask], s)).toEqual([]);
    expect(s.pass.approved).toBe(1);
  });
  test("an approval's swipe never becomes a decision, however far", () => {
    expect(swipeDecision(W, W, 3, { approval: canCommit(ask, "seen") === false })).toBeNull();
  });
  test("a card replied to stays on top until you decide it, even as the reply takes it out of the queue", () => {
    const [a, b, c] = three();
    let s = holdCard(EMPTY_DECK, a);
    // the reply marked it seen and the agent is working: no longer actionable, but still the card in hand
    const running = item("a", { status: "running", unread: false, lastRole: "user" });
    expect(deckQueue([running, b, c], s).map((i) => i.id)).toEqual(["a", "b", "c"]);
    expect(deckQueue([running, b, c], s)[0]).toBe(running); // the live copy, so the thread and state are current
    s = commitCard(s, running, "later");
    expect(deckQueue([running, b, c], s).map((i) => i.id)).toEqual(["b", "c"]);
    expect(s.held).toBeNull();
  });
  test("a held card that disappears from the list (archived, deleted) goes with it", () => {
    const [a, b] = three();
    const s = holdCard(EMPTY_DECK, a);
    expect(deckQueue([b], s).map((i) => i.id)).toEqual(["b"]);
  });
  test("undoing a held card holds it again", () => {
    const [a, b] = three();
    const running = item("a", { status: "running", unread: false });
    let s = holdCard(EMPTY_DECK, a);
    s = commitCard(s, a, "seen");
    s = undoCard(s, a, "seen", true);
    expect(deckQueue([running, b], s).map((i) => i.id)).toEqual(["a", "b"]);
  });
  test("reconciling pins the card on top and forgets dismissals the list has outgrown", () => {
    const [a, b, c] = three();
    let s = commitCard(EMPTY_DECK, a, "seen");
    s = reconcileDeck(s, [b, c]);
    expect(s.dismissed.size).toBe(0);
    expect(s.topId).toBe("a1/b");
    // the list re-sorts: b stays under the thumb
    expect(deckQueue([c, b], s).map((i) => i.id)).toEqual(["b", "c"]);
    // nothing changed: the same state object, so React does not re-render
    expect(reconcileDeck(s, [c, b])).toBe(s);
  });
});

describe("what the card says", () => {
  const r = (role: "user" | "assistant" | "tool") => ({ role, text: role });
  test("New goes after your last message, when the agent has written since", () => {
    expect(unreadBoundary([r("assistant"), r("user"), r("tool"), r("assistant")], true)).toBe(2);
    expect(unreadBoundary([r("assistant"), r("assistant")], true)).toBe(0); // you never spoke: all of it is new
  });
  test("no New line on a read card, an unloaded thread, or when the last word is yours", () => {
    expect(unreadBoundary([r("user"), r("assistant")], false)).toBeNull();
    expect(unreadBoundary(undefined, true)).toBeNull();
    expect(unreadBoundary([r("assistant"), r("user")], true)).toBeNull();
    expect(unreadBoundary([r("user"), r("tool")], true)).toBeNull();
  });
  test("days read Today, Yesterday, the weekday, then the date", () => {
    const now = new Date(2026, 8, 23, 10, 0).getTime();
    expect(dayLabel(new Date(2026, 8, 23, 0, 5).toISOString(), now)).toBe("Today");
    expect(dayLabel(new Date(2026, 8, 22, 23, 50).toISOString(), now)).toBe("Yesterday");
    expect(dayLabel(new Date(2026, 8, 19, 9).toISOString(), now)).toBe("Saturday");
    expect(dayLabel(new Date(2026, 7, 2, 9).toISOString(), now)).toMatch(/2 Aug/);
    expect(dayLabel(new Date(2025, 7, 2, 9).toISOString(), now)).toMatch(/2025/);
    expect(dayLabel(null, now)).toBeNull();
    expect(dayLabel("not a date", now)).toBeNull();
  });
  test("the notice says what the agent waits on, or what it is doing after your reply", () => {
    expect(cardNotice({ status: "done", agentName: "friday" }, "idle")).toBeNull(); // a plain wait: the box's "Message friday" says it
    expect(cardNotice({ status: "approval", agentName: "friday" }, "idle")).toBe("friday needs your approval");
    expect(cardNotice({ status: "question", agentName: "friday" }, "idle")).toBe("friday asked you something");
    expect(cardNotice({ status: "failed", agentName: null }, "idle")).toBe("The agent's last turn failed");
    expect(cardNotice({ status: "running", agentName: "friday" }, "idle")).toBe("friday is working");
    expect(cardNotice({ status: "done", agentName: "friday" }, "streaming")).toBe("friday is writing");
  });
  test("screen readers hear the outcome, the next card and the count", () => {
    expect(reviewAnnouncement("seen", { id: "b", title: "Fix the shell" }, 2)).toBe("Marked as read. Next: Fix the shell. 2 left.");
    expect(reviewAnnouncement("later", { id: "b", title: null }, 1)).toBe("Moved to Later. Next: b. 1 left.");
    expect(reviewAnnouncement("approve", undefined, 0)).toBe("Approved. You're caught up.");
  });
});
