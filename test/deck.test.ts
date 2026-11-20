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
  passTotal,
  pruneDismissed,
  reconcileDeck,
  restore,
  reviewAnnouncement,
  revealOpacity,
  rotationFor,
  stackPose,
  summaryLine,
  releaseDirection,
  dragAxis,
  gestureFor,
  markOf,
  stillTheCard,
  cardActions,
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

const W = 366;
const ask = item("q", { status: "approval", pendingApproval: { requestId: "r1", toolName: "Bash", input: "ls", at: "2026-09-07T10:01:00Z" } });
const right = (dx: number, v = 0) => releaseDirection(dx, 0, W, v, 0, "body");

describe("a release's direction", () => {
  test("past 40 % of the width, a body swipe goes right or left", () => {
    expect(right(W * COMMIT_FRACTION)).toBe("right");
    expect(right(-W * COMMIT_FRACTION)).toBe("left");
    expect(right(-W)).toBe("left");
    expect(right(-(W * COMMIT_FRACTION - 1))).toBeNull();
    expect(right(60, 0.2)).toBeNull();
    expect(right(0)).toBeNull();
  });
  test("a quick flick commits short of the distance, but not one flicked back", () => {
    expect(right(40, 0.6)).toBe("right");
    expect(right(-40, -0.6)).toBe("left");
    expect(right(-40, 1.5)).toBeNull();
    expect(right(DRAG_SLOP, 2)).toBeNull();
  });
  test("a body swipe never goes up: the thread scrolls (R5)", () => {
    expect(releaseDirection(0, -W, W, 0, -3, "body")).toBeNull();
  });
  test("the reply box goes up as well, on its longer axis, and never down (R3)", () => {
    expect(releaseDirection(10, -W * COMMIT_FRACTION, W, 0, 0, "box")).toBe("up");
    expect(releaseDirection(W * COMMIT_FRACTION, -20, W, 0, 0, "box")).toBe("right");
    expect(releaseDirection(0, W, W, 0, 3, "box")).toBeNull();
    expect(releaseDirection(0, -40, W, 0, -0.6, "box")).toBe("up");
  });
  test("a missing width cannot commit", () => {
    expect(releaseDirection(500, 0, 0, 0, 0, "body")).toBeNull();
    expect(releaseDirection(500, 0, Number.NaN, 0, 0, "box")).toBeNull();
  });
});

describe("a drag's axis", () => {
  test("the body takes only sideways drags past the slop", () => {
    expect(dragAxis(9, 2, "body")).toBe("x");
    expect(dragAxis(20, -25, "body")).toBeNull();
    expect(dragAxis(3, 1, "body")).toBeNull();
  });
  test("the box takes sideways drags and upward ones", () => {
    expect(dragAxis(9, 2, "box")).toBe("x");
    expect(dragAxis(2, -9, "box")).toBe("y");
    expect(dragAxis(2, 9, "box")).toBeNull();
  });
});

describe("a drag on a card that changes while it is held", () => {
  test("a chat that raises an approval mid-drag is not the card the drag began on, so the release snaps back", () => {
    const chat = item("c1");
    const asking = item("c1", { status: "approval", pendingApproval: { requestId: "r9", toolName: "Bash", input: "rm", at: "2026-09-07T10:02:00Z" } });
    expect(stillTheCard(markOf(chat), chat)).toBe(true);
    expect(stillTheCard(markOf(chat), asking)).toBe(false);
    expect(stillTheCard(markOf(asking), item("c1"))).toBe(false);
  });
  test("another card on top, or none, is never the held card", () => {
    expect(stillTheCard(markOf(item("c1")), item("c2"))).toBe(false);
    expect(stillTheCard(markOf(item("c1")), undefined)).toBe(false);
    expect(stillTheCard(null, item("c1"))).toBe(false);
  });
});

describe("the gesture table (U1)", () => {
  const none = { typed: false, sending: false };
  const typed = { typed: true, sending: false };
  const via = (g: ReturnType<typeof gestureFor>) => ("via" in g ? g.via : `refused:${g.refused}`);
  const row = (it: AttentionItem, o = none) => (["right", "left", "up"] as const).map((d) => via(gestureFor(it, d, o)));

  test("a chat: Read, Later, Archive; with a reply in the box, Read is refused (R2, R3, R20)", () => {
    expect(row(item("c1"))).toEqual(["seen", "later", "archive"]);
    expect(row(item("c1"), typed)).toEqual(["refused:typed", "later", "archive"]);
  });
  test("a main chat cannot be archived (R4, AE1)", () => {
    expect(row(item("default"))).toEqual(["seen", "later", "refused:main"]);
    expect(row(item("default"), typed)).toEqual(["refused:typed", "later", "refused:main"]);
  });
  test("Gmail archives; a proposed reply still lets it go up (AE5)", () => {
    expect(row(outsideItem("Lunch"))).toEqual(["seen", "later", "archive"]);
    expect(row(outsideItem("Lunch"), typed)).toEqual(["refused:typed", "later", "archive"]);
  });
  test("Jira ends with Read: up is refused", () => {
    expect(row(jiraItem())).toEqual(["seen", "later", "refused:jira"]);
  });
  test("an approval: right approves, left denies, up is refused; a reply in the box refuses both (R6, R20)", () => {
    expect(row(ask)).toEqual(["approve", "deny", "refused:decide"]);
    expect(row(ask, typed)).toEqual(["refused:typed", "refused:typed", "refused:decide"]);
  });
  test("a reply still sending refuses every gesture", () => {
    expect(row(item("c1"), { typed: false, sending: true })).toEqual(["refused:sending", "refused:sending", "refused:sending"]);
  });
});

describe("the card's actions for the ⋯ (R9, R10)", () => {
  const opts = { typed: false, sending: false, always: false, handoff: true };
  const list = (it: AttentionItem, o = opts) => cardActions(it, o).map((a) => `${a.via}${a.gesture ? `:${a.gesture}` : ""}${a.refused ? "!" : ""}`);

  test("a chat lists Read, Later and Archive with their gestures", () => {
    expect(list(item("c1"))).toEqual(["seen:right", "later:left", "archive:up"]);
  });
  test("a main chat has no Archive (AE1)", () => {
    expect(list(item("default"))).toEqual(["seen:right", "later:left"]);
  });
  test("Gmail adds Label and Hand Off; Jira has Hand Off but no Archive or Label (AE3)", () => {
    expect(list(outsideItem("Lunch"))).toEqual(["seen:right", "later:left", "archive:up", "label", "handoff"]);
    expect(list(jiraItem())).toEqual(["seen:right", "later:left", "handoff"]);
    expect(list(jiraItem(), { ...opts, handoff: false })).toEqual(["seen:right", "later:left"]);
  });
  test("an approval lists Approve, Deny, Always Allow when offered, and Later", () => {
    expect(list(ask)).toEqual(["approve:right", "deny:left", "later"]);
    expect(list(ask, { ...opts, always: true })).toEqual(["approve:right", "deny:left", "always", "later"]);
  });
  test("a disconnected account's card keeps Hand Off but refuses it, as its old button did", () => {
    const mail = outsideItem("Lunch");
    const gone: AttentionItem = { ...mail, outside: mail.outside && { ...mail.outside, disconnected: "sign_in_again" } };
    expect(cardActions(gone, opts).find((a) => a.via === "handoff")?.refused).toBe("disconnected");
    expect(cardActions(mail, opts).find((a) => a.via === "handoff")?.refused).toBeNull();
  });
  test("with a reply in the box, Read, Approve and Deny show refused", () => {
    expect(list(item("c1"), { ...opts, typed: true })).toEqual(["seen:right!", "later:left", "archive:up"]);
    expect(list(ask, { ...opts, typed: true })).toEqual(["approve:right!", "deny:left!", "later"]);
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
  test("one card shows behind the top one: 0.97 / 6px / dimmer (R16)", () => {
    expect(stackPose(0)).toEqual({ scale: 1, offsetY: 0, opacity: 1 });
    expect(stackPose(1)).toEqual({ scale: 0.97, offsetY: 6, opacity: 0.7 });
    expect(stackPose(2)).toEqual(stackPose(1));
    expect(stackPose(5)).toEqual(stackPose(1));
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
    expect(pruneDismissed(d, [item("b", { lastAssistantText: "more" })]).size).toBe(0);
    expect(pruneDismissed(d, [b]).size).toBe(1);
  });
  test("an entry lasts while the chat is unchanged: a turn starting takes it out of the Inbox, and the entry goes", () => {
    const b = item("b");
    const d = dismiss(new Map(), b);
    expect(pruneDismissed(d, [item("b", { status: "idle", unread: false })]).size).toBe(1);
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

describe("the review pass: Next, Archive, undo, approvals", () => {
  const three = () => [item("a"), item("b"), item("c")];

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
  test("Later takes an approval only from the ⋯ (R10)", () => {
    expect(canCommit(ask, "later", "menu")).toBe(true);
    expect(canCommit(ask, "seen", "menu")).toBe(false);
  });
  test("a card replied to stays on top until you decide it, even as the reply takes it out of the queue", () => {
    const [a, b, c] = three();
    let s = holdCard(EMPTY_DECK, a);
    const running = item("a", { status: "running", unread: false, lastRole: "user" });
    expect(deckQueue([running, b, c], s).map((i) => i.id)).toEqual(["a", "b", "c"]);
    expect(deckQueue([running, b, c], s)[0]).toBe(running);
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
    expect(deckQueue([c, b], s).map((i) => i.id)).toEqual(["b", "c"]);
    expect(reconcileDeck(s, [c, b])).toBe(s);
  });
});

describe("what the card says", () => {
  const r = (role: "user" | "assistant" | "tool") => ({ role, text: role });
  test("New goes after your last message, when the agent has written since", () => {
    expect(unreadBoundary([r("assistant"), r("user"), r("tool"), r("assistant")], true)).toBe(2);
    expect(unreadBoundary([r("assistant"), r("assistant")], true)).toBe(0);
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
    expect(cardNotice({ status: "done", agent_name: "friday" }, "idle")).toBeNull();
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
    const way = gestureFor(mail, "right", { typed: false, sending: false });
    if (!("via" in way) || way.via !== "seen") throw new Error("a right swipe should read");
    expect(await makeMove(t.moves, mail, way.via, "swipe")).toEqual({ error: null, ask: false });
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
    ledger.takenBack(idOf(a));
    s = undoCard(s, a, "seen");
    const undone = s;
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
