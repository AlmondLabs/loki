import { describe, expect, test } from "vitest";
import type { AttentionItem } from "../core/attention/model.ts";
import { idOf, stampOf } from "../core/attention/queue.ts";
import {
  COMMIT_FRACTION,
  DRAG_SLOP,
  EMPTY_DECK,
  EMPTY_PASS,
  MAX_ROTATION,
  canCommit,
  cardNotice,
  commitCard,
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
  visibleQueue,
  UNDO_MS,
  dateChoice,
  makeMove,
  returnChoices,
  undoMove,
  moveLedger,
} from "../app/src/phone/deck.ts";
import { dayLabel, unreadBoundary } from "../app/src/shared/thread.ts";
import { createCardMoves, type CardMovesHost } from "../core/attention/use-attention.ts";
import { keyOf } from "../core/attention/model.ts";
import { RETURN_TIMES_DEFAULT, type Rest, type ReturnTimes } from "../core/attention/rest.ts";
import type { OutsideChange, OutsideWrite } from "../core/frame-types.ts";
import { jiraItem, outsideItem } from "./fixtures/outside-item.ts";

/**
 * The phone deck's pure half (app/src/phone/deck.ts): when a drag commits and which way, how the
 * card leans and the reveal shows, what a pass adds up to, and which swiped cards stay hidden
 * until they move on. No DOM.
 */

const item = (id: string, over: Partial<AttentionItem> = {}): AttentionItem => ({
  id,
  agent_id: "a1",
  agent_name: "ira",
  title: id,
  last_message_at: "2026-09-07T10:00:00Z",
  archived: false,
  status: "done",
  lastAssistantText: "x",
  lastRole: "assistant",
  pendingApproval: null,
  pendingQuestion: null,
  error: null,
  seenAt: null,
  unread: true,
  viewedAt: null,
  lastAsk: null,
  score: 0,
  reason: "other",
  focus: 0,
  runtime: { agent_id: "a1", conversation_id: id },
  ...over,
});

const W = 366; // a 390 phone minus the 12px margins
const plain = { approval: false };
const approval = { approval: true };

describe("swipe decision", () => {
  test("past 40 % of the width, right is seen (read) and left is later, on every card; archiving has its button alone", () => {
    expect(swipeDecision(W * COMMIT_FRACTION, W, 0, plain)).toBe("seen");
    expect(swipeDecision(-W * COMMIT_FRACTION, W, 0, plain)).toBe("later");
    expect(swipeDecision(200, W, 0, plain)).toBe("seen");
    expect(swipeDecision(-W, W, 0, plain)).toBe("later");
  });
  test("a left swipe short of the distance springs back", () => {
    expect(swipeDecision(-(W * COMMIT_FRACTION - 1), W, 0, plain)).toBeNull();
    expect(swipeDecision(-60, W, 0, plain)).toBeNull();
  });
  test("with text in the reply box, a swipe either way springs back, so nothing is sent", () => {
    expect(swipeDecision(W, W, 3, { approval: false, typed: true })).toBeNull();
    expect(swipeDecision(-W, W, -3, { approval: false, typed: true })).toBeNull();
  });
  test("short of the distance and slow: springs back", () => {
    expect(swipeDecision(W * COMMIT_FRACTION - 1, W, 0, plain)).toBeNull();
    expect(swipeDecision(60, W, 0.2, plain)).toBeNull();
    expect(swipeDecision(-60, W, -0.2, plain)).toBeNull();
    expect(swipeDecision(0, W, 0, plain)).toBeNull();
  });
  test("a fast flick commits short of the distance, in the drag's own direction", () => {
    expect(swipeDecision(40, W, 0.6, plain)).toBe("seen");
    expect(swipeDecision(-40, W, -0.6, plain)).toBe("later");
    expect(swipeDecision(-40, W, 1.5, plain)).toBeNull();
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

describe("a release that turns back", () => {
  test("past the distance but flicked back left before letting go: springs back", () => {
    expect(swipeDecision(W * COMMIT_FRACTION + 20, W, -1.5, plain)).toBeNull();
    // a little drift back is not a change of mind
    expect(swipeDecision(W * COMMIT_FRACTION + 20, W, -0.05, plain)).toBe("seen");
  });
});

describe("pass summary", () => {
  test("tallies each way off the deck and prints only what happened", () => {
    let s = EMPTY_PASS;
    expect(summaryLine(s)).toBe("");
    s = tally(s, "seen");
    s = tally(s, "seen");
    s = tally(s, "later");
    s = tally(s, "archive");
    expect(s).toEqual({ seen: 2, later: 1, archived: 1, approved: 0, denied: 0 });
    expect(summaryLine(s)).toBe("2 read · 1 later · 1 archived");
    expect(passTotal(s)).toBe(4);
    s = tally(s, "approve");
    s = tally(s, "deny");
    expect(summaryLine(s)).toBe("2 read · 1 later · 1 archived · 1 approved · 1 denied");
  });
  test("undo takes one back and never goes below zero", () => {
    let s = tally(EMPTY_PASS, "seen");
    s = tally(s, "seen", -1);
    expect(s.seen).toBe(0);
    s = tally(s, "archive", -1);
    expect(s.archived).toBe(0);
  });
});

describe("dismissed unless the stamp changed", () => {
  test("a swiped card stays out while its content holds, even if the list re-sorts or timestamps move", () => {
    const a = item("a"),
      b = item("b");
    const d = dismiss(new Map(), a);
    expect(visibleQueue([a, b], d).map((i) => i.id)).toEqual(["b"]);
    expect(visibleQueue([b, a], d).map((i) => i.id)).toEqual(["b"]);
    const bumped = item("a", { last_message_at: "2026-09-07T10:05:00Z" });
    expect(stampOf(bumped)).toBe(stampOf(a));
    expect(visibleQueue([bumped, b], d).map((i) => i.id)).toEqual(["b"]);
  });
  test("a new reply or a new approval brings it back", () => {
    const a = item("a");
    const d = dismiss(new Map(), a);
    expect(visibleQueue([item("a", { lastAssistantText: "something new" })], d).map((i) => i.id)).toEqual(["a"]);
    expect(
      visibleQueue([item("a", { status: "approval", pendingApproval: { requestId: "r1", toolName: "Bash", input: "ls", at: "2026-09-07T10:01:00Z" } })], d).map(
        (i) => i.id,
      ),
    ).toEqual(["a"]);
  });
  test("undo restores; pruning drops entries the live list has outgrown", () => {
    const a = item("a"),
      b = item("b");
    let d = dismiss(dismiss(new Map(), a), b);
    expect(visibleQueue([a, b], d)).toEqual([]);
    d = restore(d, a);
    expect(visibleQueue([a, b], d).map((i) => i.id)).toEqual(["a"]);
    // b moved on, a is gone from the list: nothing left to remember
    expect(pruneDismissed(d, [item("b", { lastAssistantText: "more" })]).size).toBe(0);
    // b unchanged and still actionable (the round trip has not landed): kept
    expect(pruneDismissed(d, [b]).size).toBe(1);
  });
  test("an entry lasts while the chat is unchanged: a turn starting takes it out of the Inbox, and the entry goes", () => {
    const b = item("b");
    const d = dismiss(new Map(), b);
    // marked read: still in the Inbox (a chat stays until it is archived), so the card stays dismissed for this visit
    expect(pruneDismissed(d, [item("b", { status: "idle", unread: false })]).size).toBe(1);
    // the agent is mid-turn: out of the Inbox for now, and the entry goes
    expect(pruneDismissed(d, [item("b", { status: "running" })]).size).toBe(0);
  });
});

describe("the top card stays on top", () => {
  test("the pinned id comes first; the rest keep their order; an unknown or null pin changes nothing", () => {
    const a = item("a"),
      b = item("b"),
      c = item("c");
    expect(toFront([a, b, c], "a1/c").map((i) => i.id)).toEqual(["c", "a", "b"]);
    expect(toFront([a, b, c], "a1/a").map((i) => i.id)).toEqual(["a", "b", "c"]);
    expect(toFront([a, b, c], null).map((i) => i.id)).toEqual(["a", "b", "c"]);
    expect(toFront([a, b, c], "a1/zz").map((i) => i.id)).toEqual(["a", "b", "c"]);
  });
});

/**
 * The deck as one state (U4): the pass a person is in the middle of — what went, what is on top, the card
 * held after a reply, the tally — as pure steps, so Next, Archive, undo and the approval refusal are
 * checked here rather than in a browser.
 */
describe("the review pass: Next, Archive, undo, approvals", () => {
  const three = () => [item("a"), item("b"), item("c")];
  const ask = item("q", { status: "approval", pendingApproval: { requestId: "r1", toolName: "Bash", input: "ls", at: "2026-09-07T10:01:00Z" } });

  test("Archive advances once: the next card is on top and one fewer is left", () => {
    const items = three();
    let s = EMPTY_DECK;
    expect(deckQueue(items, s).map((i) => i.id)).toEqual(["a", "b", "c"]);
    s = commitCard(s, items[0], "archive");
    expect(deckQueue(items, s).map((i) => i.id)).toEqual(["b", "c"]);
    expect(s.pass).toEqual({ ...EMPTY_PASS, archived: 1 });
  });
  test("Next advances once, and undo puts the same card back on top with the count restored", () => {
    const items = three();
    let s = commitCard(EMPTY_DECK, items[0], "seen");
    expect(deckQueue(items, s)).toHaveLength(2);
    s = undoCard(s, items[0], "seen");
    expect(deckQueue(items, s).map((i) => i.id)).toEqual(["a", "b", "c"]);
    expect(passTotal(s.pass)).toBe(0);
  });
  test("an undone card returns on top even when the list has re-sorted under it", () => {
    const [a, b, c] = three();
    let s = commitCard(EMPTY_DECK, b, "archive");
    s = undoCard(s, b, "archive");
    expect(deckQueue([a, b, c], s)[0].id).toBe("b");
  });
  test("an approval refuses Read, Later and Archive: the state does not move", () => {
    const s = EMPTY_DECK;
    expect(canCommit(ask, "archive")).toBe(false);
    expect(canCommit(ask, "seen")).toBe(false);
    expect(canCommit(ask, "later")).toBe(false);
    expect(commitCard(s, ask, "later")).toBe(s);
    expect(commitCard(s, ask, "archive")).toBe(s);
    expect(commitCard(s, ask, "seen")).toBe(s);
    expect(deckQueue([ask], s).map((i) => i.id)).toEqual(["q"]);
  });
  test("a main chat cannot be archived, only moved past", () => {
    const main = item("default");
    const s = EMPTY_DECK;
    expect(canCommit(main, "archive")).toBe(false);
    expect(commitCard(s, main, "archive")).toBe(s);
    expect(canCommit(main, "seen")).toBe(true);
    expect(commitCard(s, main, "seen").pass.seen).toBe(1);
  });
  test("a Jira card refuses Archive, so its swipe or button springs back; Read and Later take it (R19, R21)", () => {
    const ticket = jiraItem();
    const s = EMPTY_DECK;
    expect(canCommit(ticket, "archive")).toBe(false);
    expect(commitCard(s, ticket, "archive")).toBe(s);
    expect(canCommit(ticket, "seen")).toBe(true);
    expect(canCommit(ticket, "later")).toBe(true);
    expect(canCommit(outsideItem("Lunch"), "archive")).toBe(true);
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
    expect(swipeDecision(W, W, 3, { approval: !canCommit(ask, "seen") })).toBeNull();
  });
  test("a card replied to stays on top until you decide it, even as the reply takes it out of the queue", () => {
    const [a, b, c] = three();
    let s = holdCard(EMPTY_DECK, a);
    // the reply marked it seen and the agent is working: no longer actionable, but still the card in hand
    const running = item("a", { status: "running", unread: false, lastRole: "user" });
    expect(deckQueue([running, b, c], s).map((i) => i.id)).toEqual(["a", "b", "c"]);
    expect(deckQueue([running, b, c], s)[0]).toBe(running); // the live copy, so the thread and state are current
    s = commitCard(s, running, "archive");
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
    expect(cardNotice({ status: "done", agent_name: "friday" }, "idle")).toBeNull(); // a plain wait: the box's "Message friday" says it
    expect(cardNotice({ status: "approval", agent_name: "friday" }, "idle")).toBe("friday needs your approval");
    expect(cardNotice({ status: "question", agent_name: "friday" }, "idle")).toBe("friday asked you something");
    expect(cardNotice({ status: "failed", agent_name: null }, "idle")).toBe("The agent's last turn failed");
    expect(cardNotice({ status: "running", agent_name: "friday" }, "idle")).toBe("friday is working");
    expect(cardNotice({ status: "done", agent_name: "friday" }, "streaming")).toBe("friday is writing");
  });
  test("screen readers hear the outcome and the next card", () => {
    expect(reviewAnnouncement("seen", { id: "b", title: "Fix the shell" }, 2)).toBe("Marked read. Next: Fix the shell.");
    expect(reviewAnnouncement("later", { id: "b", title: "Fix the shell" }, 2)).toBe("Saved for later. Next: Fix the shell.");
    expect(reviewAnnouncement("archive", { id: "b", title: null }, 1)).toBe("Archived. Next: b.");
    expect(reviewAnnouncement("approve", undefined, 0)).toBe("Approved. You've been through every chat.");
    expect(reviewAnnouncement("deny", { id: "b", title: "b" }, 0)).toBe("Denied. You've been through every chat.");
  });
});

/** A fake host for the real card moves (core/attention/use-attention.ts): the write-backs out there, seen marks and rests. */
function movesHost(refuse: string | null = null, returnTimes: ReturnTimes = RETURN_TIMES_DEFAULT) {
  const rests: Record<string, Rest> = {};
  const marks: string[] = [];
  const calls: string[] = [];
  const change = (move: OutsideWrite): OutsideChange => ({
    move,
    messages: [{ message_id: "m1", labels_added: [], labels_removed: [] }],
    ended: false,
    was_unread: true,
  });
  const write = (move: OutsideWrite) => (card: { id: string }) => {
    if (refuse) return Promise.resolve({ change: null, error: refuse });
    calls.push(`${move} ${card.id}`);
    return Promise.resolve({ change: change(move), error: null });
  };
  const h: CardMovesHost = {
    store: {
      markReadOutside: write("read"),
      markUnreadOutside: write("unread"),
      archiveOutside: write("archive"),
      labelOutside: write("label"),
      restoreOutside: (card, c) => (calls.push(`restore ${card.id} ${c.move}`), Promise.resolve(null)),
      archiveConversation: (id, archived) => (calls.push(`${archived ? "archive" : "unarchive"} chat ${id}`), Promise.resolve(null)),
    },
    rests: () => rests,
    rest: (agentId, conversationId, rest) => {
      rests[keyOf(agentId, conversationId)] = rest;
    },
    markSeen: (_agentId, conversationId) => void marks.push(`seen ${conversationId}`),
    unmarkSeen: (_agentId, conversationId) => void marks.push(`unseen ${conversationId}`),
    returnTimes: () => returnTimes,
    now: () => Date.parse("2026-11-05T12:00:00Z"),
    report: () => {},
    reportUndone: () => {},
  };
  return { moves: createCardMoves(h), rests, marks, calls };
}

describe("the phone's moves (plan 070, U8)", () => {
  const mail = outsideItem("Quarterly numbers");

  test("a right swipe on an email card marks it read out there, through the read move", async () => {
    const t = movesHost();
    const way = swipeDecision(W, W, 0, plain);
    expect(way).toBe("seen");
    if (!way) return;
    expect(await makeMove(t.moves, mail, way, "swipe")).toEqual({ error: null, ask: false });
    expect(t.calls).toEqual(["read t1#1"]);
    expect(t.marks).toEqual(["seen t1#1"]);
  });

  test("a left swipe leaves it unread out there and rests it until it comes back", async () => {
    const t = movesHost();
    expect(await makeMove(t.moves, mail, "later", "swipe")).toEqual({ error: null, ask: false });
    expect(t.calls).toEqual(["unread t1#1"]);
    expect(Object.values(t.rests).map((r) => r.kind)).toEqual(["later"]);
  });

  test("undo within six seconds of a later swipe brings the card back on top, unread", async () => {
    const t = movesHost();
    const [a, b] = [mail, item("b")];
    let s = commitCard(EMPTY_DECK, a, "later");
    expect(deckQueue([a, b], s).map((i) => i.id)).toEqual(["b"]);
    expect(s.pass.later).toBe(1);
    await makeMove(t.moves, a, "later", "swipe");
    expect(UNDO_MS).toBe(6000);
    expect(await undoMove(t.moves, a)).toBeNull();
    s = undoCard(s, a, "later");
    expect(deckQueue([b, a], s).map((i) => i.id)).toEqual(["t1#1", "b"]);
    expect(s.pass.later).toBe(0);
    // The thread is put back as it was, and loki never marked it seen: it is still unread.
    expect(t.calls).toEqual(["unread t1#1", "restore t1#1 unread"]);
    expect(t.marks).toEqual([]);
  });

  test("a failed move says why, in the phone's words", async () => {
    const t = movesHost("Gmail refused");
    expect(await makeMove(t.moves, mail, "seen", "tap")).toEqual({ error: "Not marked read: Gmail refused", ask: false });
    expect(await makeMove(t.moves, mail, "later", "tap")).toEqual({ error: "Not saved for later: Gmail refused", ask: false });
    expect(await makeMove(t.moves, mail, "archive", "tap")).toEqual({ error: "Not archived: Gmail refused", ask: false });
  });

  test("a later follows the person's return time, not the default", async () => {
    // The phone hands useAttention the daemon's return times (phone.tsx, as shell.tsx does); the moves rest by them.
    const times: ReturnTimes = { ...RETURN_TIMES_DEFAULT, later: { ...RETURN_TIMES_DEFAULT.later, email: "3h" } };
    const t = movesHost(null, times);
    await makeMove(t.moves, mail, "later", "swipe");
    expect(Object.values(t.rests).map((r) => r.until)).toEqual(["2026-11-05T15:00:00.000Z"]);
  });

  test("a write-back failing after the person tapped Undo leaves the tally and the card as the undo left them", () => {
    const [a, b] = [item("a"), item("b")];
    const ledger = moveLedger();
    let s = commitCard(EMPTY_DECK, a, "seen");
    const move = ledger.made(idOf(a));
    // Undo comes first: the card is back on top and the tally is clear.
    ledger.takenBack(idOf(a));
    s = undoCard(s, a, "seen");
    const undone = s;
    // Then the read fails out there: it is no longer the standing move, so nothing is brought back a second time.
    expect(ledger.stands(idOf(a), move)).toBe(false);
    expect(undone.pass).toEqual(EMPTY_PASS);
    expect(deckQueue([a, b], undone).map((i) => i.id)).toEqual(["a", "b"]);
  });

  test("a failure from an older move does not bring back a newer one on the same card", () => {
    const ledger = moveLedger();
    const first = ledger.made("a1/a");
    ledger.takenBack("a1/a");
    const second = ledger.made("a1/a");
    expect(ledger.stands("a1/a", first)).toBe(false);
    expect(ledger.stands("a1/a", second)).toBe(true);
    expect(ledger.stands("a1/b", second)).toBe(false);
  });

  test("an undo after a hand-off says it was handed off; any other refusal says why", async () => {
    const t = movesHost();
    expect(await undoMove({ ...t.moves, undo: () => Promise.resolve("handed off") }, mail)).toBe("Handed off, not undone");
    expect(await undoMove({ ...t.moves, undo: () => Promise.resolve("Gmail refused") }, mail)).toBe("Not undone: Gmail refused");
  });
});

describe("when a card put off comes back (R7)", () => {
  // Thursday 5 November 2026, at noon where the test runs: the choices are counted in local days.
  const now = new Date(2026, 10, 5, 12, 0);
  const at = (d: number, h: number) => new Date(2026, 10, d, h, 0).toISOString();

  test("later today, tomorrow morning, in 3 days, next Monday morning", () => {
    expect(returnChoices(now)).toEqual([
      { label: "Later today", until: at(5, 15) },
      { label: "Tomorrow", until: at(6, 8) },
      { label: "In 3 days", until: at(8, 8) },
      { label: "Next week", until: at(9, 8) },
    ]);
  });
  test("late in the evening there is no later today", () => {
    expect(returnChoices(new Date(2026, 10, 5, 22, 0)).map((c) => c.label)).toEqual(["Tomorrow", "In 3 days", "Next week"]);
  });
  test("a picked date comes back that morning; today, a past day or nonsense is no pick", () => {
    expect(dateChoice("2026-11-20", now)).toBe(at(20, 8));
    expect(dateChoice("2026-11-05", now)).toBeNull();
    expect(dateChoice("2026-11-01", now)).toBeNull();
    expect(dateChoice("soon", now)).toBeNull();
  });
});
