import { describe, expect, test } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { SetStateAction } from "react";
import type { AttentionItem } from "../core/attention/model.ts";
import { idOf, inboxQueue, type Decision } from "../core/attention/queue.ts";
import { agentLane, laneEvent, laneItems, otherLanesCount, type Lane, type ResolvedLane } from "../core/attention/lanes.ts";
import type { MoveResult } from "../core/attention/use-attention.ts";
import * as parts from "../app/src/desk/catch-up-parts.tsx";
import { FlowCaughtUp, VisitSummary } from "../app/src/desk/catch-up-parts.tsx";
import { flowLanes } from "../app/src/desk/flow-column.tsx";
import { switchLane } from "../app/src/desk/use-deck-queue.ts";
import { EMPTY_REPLY, createDeckMoves } from "../app/src/desk/deck-moves.ts";
import { answeredElsewhere, createVisit, endOnPageHide, liveRows } from "../app/src/desk/use-flow-deck.ts";
import { attentionItem } from "./fixtures/attention.ts";

/** The desktop Flow's lanes (plan 087, U6): the deck's lane, the quiet count and undo across switches; the empty list and the visit's summary; and a visit's end. */

const WORK: Lane = { id: "w", name: "Work", chats: ["ag-work"], accounts: [] };
const HOME: Lane = { id: "h", name: "Home", chats: ["ag-home"], accounts: [] };
const of = (id: string, agentId: string, agentName: string, over: Partial<AttentionItem> = {}) =>
  attentionItem(id, { agent_id: agentId, agent_name: agentName, runtime: { agent_id: agentId, conversation_id: id }, ...over });
const work = of("w1", "ag-work", "Ada");
const home = of("h1", "ag-home", "Bo");
const ids = (q: AttentionItem[]) => q.map((i) => i.id);
const noop = () => {};

const DONE: MoveResult = { error: null, ask: false, rest: null };
const settle = () => new Promise<void>((r) => setImmediate(r));

/** A deck with `queue` up in `lane` and its first row selected, recording every move it makes out there. */
function deck(queue: AttentionItem[], lane: ResolvedLane | null) {
  const calls: Array<[string, string]> = [];
  const state = { queue, selected: null as string | null, decided: [] as Decision[], lane, flash: [] as string[] };
  const apply = <T>(v: SetStateAction<T>, old: T): T => (typeof v === "function" ? (v as (o: T) => T)(old) : v);
  /** The selected card: the one picked, else the first row. */
  const selected = () => state.queue.find((i) => idOf(i) === state.selected) ?? state.queue.at(0);
  const moves = () =>
    createDeckMoves({
      selected,
      queue: state.queue,
      select: (id) => (state.selected = id),
      decided: state.decided,
      lane: state.lane,
      replyOf: () => EMPTY_REPLY,
      setReply: noop,
      setSending: noop,
      setDecided: (v) => (state.decided = apply(v, state.decided)),
      setQueue: (v) => (state.queue = apply(v, state.queue)),
      say: (w) => state.flash.push(w),
      setDir: noop,
      pick: noop,
      sent: noop,
      moves: {
        read: (item) => (calls.push(["read", item.id]), Promise.resolve(DONE)),
        later: (item) => (calls.push(["later", item.id]), Promise.resolve(DONE)),
        laterAsks: () => false,
        archive: (item) => (calls.push(["archive", item.id]), Promise.resolve(null)),
        label: () => Promise.resolve(null),
        undo: (item) => (calls.push(["undo", item.id]), Promise.resolve(null)),
        seen: noop,
        unread: noop,
        approve: noop,
      },
    });
  /** Switch the deck to `next`, as the queue hook does on a lane change. */
  const switchTo = (next: ResolvedLane | null, items: AttentionItem[]) => {
    state.lane = next;
    const at = selected();
    state.queue = switchLane(state.queue, laneItems(items, next), next, state.decided, false, at ? idOf(at) : null);
  };
  return { state, calls, moves, switchTo, shown: () => selected()?.id };
}

describe("the lanes are sources, not a menu in the title (plan 2026-11-14-1330, U6)", () => {
  test("no lane menu or agent pills are left to render", () => {
    for (const gone of ["DeckHeader", "LaneMenu", "laneMenuEntries", "laneTitle", "AgentPills", "agentPills"]) expect(gone in parts).toBe(false);
  });
});

describe("the deck in a lane", () => {
  // AE3: an approval outside Work stays out of Work's deck and only raises the quiet count.
  test("in Work an approval outside it is not in the deck, and only the counts outside it say so", () => {
    const asks = of("h2", "ag-home", "Bo", { status: "approval" });
    const items = [work, asks];
    expect(ids(inboxQueue(laneItems(items, WORK)))).toEqual(["w1"]);
    expect(otherLanesCount(items, WORK)).toBe(1);
    expect(flowLanes(items, WORK, [WORK, HOME]).map((l) => [l.name, l.count])).toEqual([
      ["Everything", 2],
      ["Work", 1],
      ["Home", 1],
      ["Ada", 1],
      ["Bo", 1],
    ]);
  });

  test("switching from Everything to Work while a Work card is selected keeps it selected", () => {
    const d = deck([work, home, of("w2", "ag-work", "Ada")], null);
    d.switchTo(WORK, [work, home, of("w2", "ag-work", "Ada")]);
    expect(ids(d.state.queue)).toEqual(["w1", "w2"]);
    expect(d.shown()).toBe("w1");
  });

  test("a lane switch keeps the visit's decisions and sorts the lane's rows afresh by score, the selection with them", async () => {
    const low = of("w3", "ag-work", "Ada", { score: 1 });
    const high = of("w4", "ag-work", "Ada", { score: 9 });
    const items = [home, low, work, high];
    const d = deck([home, low, work, high], null);
    d.moves().read();
    await settle();
    d.state.selected = idOf(work);
    d.switchTo(WORK, items);
    expect(ids(d.state.queue)).toEqual(["w4", "w3", "w1"]);
    expect(d.shown()).toBe("w1");
    expect(d.state.decided.map((x) => x.item.id)).toEqual(["h1"]);
  });

  test("switching to Work while a Home card is on top takes it off the deck with no read, later or archive", async () => {
    const d = deck([home, work], null);
    d.switchTo(WORK, [home, work]);
    await settle();
    expect(ids(d.state.queue)).toEqual(["w1"]);
    expect(d.calls).toEqual([]);
    expect(d.state.decided).toEqual([]);
  });

  test("a Home card read in Everything is out of undo's reach in Work, and back in it in Everything", async () => {
    const items = [home, work];
    const d = deck([home, work], null);
    d.moves().read();
    await settle();
    d.switchTo(WORK, items);
    d.moves().undo();
    await settle();
    expect(d.calls).toEqual([["read", "h1"]]);
    expect(ids(d.state.queue)).toEqual(["w1"]);
    d.switchTo(null, items);
    d.moves().undo();
    await settle();
    expect(d.calls).toEqual([
      ["read", "h1"],
      ["undo", "h1"],
    ]);
    expect(ids(d.state.queue)[0]).toBe("h1");
    expect(d.shown()).toBe("h1");
    expect(d.state.decided).toEqual([]);
  });

  // AE5: switching writes nothing, so a card resting after read rests on with the same return time.
  test("a resting card stays resting, untouched, after switching to a lane that hides it and back", async () => {
    const resting = of("h3", "ag-home", "Bo", { resting: true, unread: false });
    const items = [resting, work];
    const d = deck(inboxQueue(items), null);
    d.switchTo(WORK, items);
    d.switchTo(null, items);
    await settle();
    expect(ids(d.state.queue)).toEqual(["w1"]);
    expect(d.calls).toEqual([]);
    expect(items[0]).toBe(resting);
    expect(laneItems(items, null)[0]).toBe(resting);
  });
});

describe("an emptied list (R12)", () => {
  test("the list says you're caught up, with Go Through Them while rested cards wait", () => {
    const html = renderToStaticMarkup(createElement(FlowCaughtUp, { resting: 3, onResting: noop }));
    expect(html).toContain("You&#x27;re caught up");
    expect(html).toContain("3 resting");
    expect(html).toContain(">Go Through Them</button>");
    expect(renderToStaticMarkup(createElement(FlowCaughtUp, { resting: 0, onResting: noop }))).not.toContain("Go Through Them");
  });

  test("the detail shows what the visit did", () => {
    const read = (item: AttentionItem): Decision => ({ item, action: "seen", via: "next", stamp: "" });
    const archived: Decision = { item: home, action: "archived", via: "archive", stamp: "" };
    const html = renderToStaticMarkup(createElement(VisitSummary, { items: [], decided: [read(work), archived], replies: 1 }));
    expect(html).toContain("2 moved past · 1 archived · 1 reply");
    expect(renderToStaticMarkup(createElement(VisitSummary, { items: [], decided: [], replies: 0 }))).not.toContain("moved past");
  });

  // AE6: Ada's lane cleared: caught up, the outside count, the way back.
  test("in an emptied lane the summary shows the other lanes' count and a way back to Everything", () => {
    const html = renderToStaticMarkup(createElement(VisitSummary, { items: [], decided: [], replies: 0, others: 2, onEverything: noop }));
    expect(html).toContain("2 waiting in other lanes");
    expect(html).toContain("Back to Everything");
    const none = renderToStaticMarkup(createElement(VisitSummary, { items: [], decided: [], replies: 0, others: 0, onEverything: noop }));
    expect(none).not.toContain("other lanes");
    expect(none).toContain("Back to Everything");
    expect(renderToStaticMarkup(createElement(VisitSummary, { items: [], decided: [], replies: 0 }))).not.toContain("Back to Everything");
  });

  test("an emptied agent lane stays among the sources while on and leaves them once the person switches away", () => {
    const items = [home, of("w9", "ag-work", "Ada", { status: "running" })];
    const ada = agentLane(items, "ag-work");
    expect(flowLanes(items, ada, []).map((l) => l.name)).toContain("Ada");
    const away = flowLanes(items, null, []).map((l) => l.name);
    expect(away).not.toContain("Ada");
    expect(away).toContain("Bo");
  });
});

describe("a visit is the time in the Flow place (KTD6)", () => {
  const read = (item: AttentionItem): Decision => ({ item, action: "seen", via: "next", stamp: "" });
  test("leaving the place fires onPass once, with the cards shown as committed selections", () => {
    const passes: unknown[] = [];
    const visit = createVisit(1_000, () => 4_000);
    visit.show(idOf(work));
    visit.show(idOf(home));
    visit.show(idOf(work));
    const tally = { decided: [read(work)], replies: 1, onPass: (p: unknown) => passes.push(p) };
    visit.end(tally);
    visit.end(tally);
    expect(passes).toEqual([{ decided: 1, next: 1, archive: 0, approve: 0, deny: 0, replies: 1, shown: 2, duration_ms: 3_000 }]);
  });

  test("hiding and showing the window fires no onPass and the visit goes on; the page unloading ends it, once", () => {
    const passes: unknown[] = [];
    const visit = createVisit(0, () => 10);
    const tally = { decided: [] as Decision[], replies: 0, onPass: (p: unknown) => passes.push(p) };
    const page = new EventTarget();
    const stop = endOnPageHide(page, () => visit.end(tally));
    page.dispatchEvent(new Event("visibilitychange"));
    page.dispatchEvent(new Event("blur"));
    expect(passes).toEqual([]);
    tally.decided = [read(home)];
    page.dispatchEvent(new Event("pagehide"));
    stop();
    visit.end(tally);
    expect(passes).toHaveLength(1);
    expect(passes[0]).toMatchObject({ decided: 1, next: 1 });
  });

  test("a visit that decided nothing and sent nothing reports nothing", () => {
    const passes: unknown[] = [];
    createVisit(0, () => 10).end({ decided: [], replies: 0, onPass: (p: unknown) => passes.push(p) });
    expect(passes).toEqual([]);
  });
});

describe("the list's rows", () => {
  test("a row draws its card as it is now: a new message updates its preview, time and unread mark, and the order stays", () => {
    const b = of("b1", "ag-work", "Ada", { lastAssistantText: "first", last_message_at: "2026-09-05T10:00:00Z", unread: false });
    const queue = [work, b, home];
    const newer = { ...b, lastAssistantText: "second", last_message_at: "2026-09-05T11:00:00Z", unread: true };
    const rows = liveRows(queue, new Map([work, newer, home].map((i) => [idOf(i), i])));
    expect(rows.map((i) => i.id)).toEqual(["w1", "b1", "h1"]);
    expect(rows[1]).toBe(newer);
  });
  test("a row whose card left the items keeps its kept snapshot", () => {
    const rows = liveRows([work, home], new Map([[idOf(home), home]]));
    expect(rows).toEqual([work, home]);
  });
});

describe("a card answered elsewhere (R11)", () => {
  const touched = new Set([idOf(work)]);
  const running = { ...work, status: "running" as const };
  const resting = { ...work, resting: true };
  test.each([
    ["still in the Inbox", work, [work], false, new Set<string>(), false],
    ["archived or gone from the items", work, [home], false, new Set<string>(), true],
    ["running after the person replied here", running, [running], false, touched, false],
    ["running with no reply from here", running, [running], false, new Set<string>(), true],
    ["resting while the visit leaves resting cards out", resting, [resting], false, new Set<string>(), true],
    ["resting while the visit goes through them", resting, [resting], true, new Set<string>(), false],
  ])("%s", (_name, item, items, rest, mine, expected) => {
    expect(answeredElsewhere(item, items, rest, mine)).toBe(expected);
  });
});

describe("analytics", () => {
  test("a lane switch reports the kind of lane, and the agent for an agent lane", () => {
    expect(laneEvent("")).toEqual({ kind: "everything", agent: null });
    expect(laneEvent(WORK.id)).toEqual({ kind: "own", agent: null });
    expect(laneEvent(agentLane([work], "ag-work").id)).toEqual({ kind: "agent", agent: "ag-work" });
  });
});
