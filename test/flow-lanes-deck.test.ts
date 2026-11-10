import { describe, expect, test } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { SetStateAction } from "react";
import type { AttentionItem } from "../core/attention/model.ts";
import { inboxQueue, type Decision } from "../core/attention/queue.ts";
import { agentLane, laneEvent, laneItems, otherLanesCount, type Lane, type ResolvedLane } from "../core/attention/lanes.ts";
import type { MoveResult } from "../core/attention/use-attention.ts";
import * as parts from "../app/src/desk/catch-up-parts.tsx";
import { CaughtUp, DeckHeader, LaneMenu, laneTitle } from "../app/src/desk/catch-up-parts.tsx";
import { switchLane } from "../app/src/desk/use-deck-queue.ts";
import { EMPTY_REPLY, createDeckMoves } from "../app/src/desk/deck-moves.ts";
import { attentionItem } from "./fixtures/attention.ts";

/** The desktop Flow's lanes (plan 087, U6): the title switcher, the deck's lane, the quiet count and undo across switches. */

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

/** A deck with `queue` up in `lane`, recording every move it makes out there. */
function deck(queue: AttentionItem[], lane: ResolvedLane | null) {
  const calls: Array<[string, string]> = [];
  const state = { queue, decided: [] as Decision[], lane, flash: [] as string[] };
  const apply = <T>(v: SetStateAction<T>, old: T): T => (typeof v === "function" ? (v as (o: T) => T)(old) : v);
  const moves = () =>
    createDeckMoves({
      current: state.queue[0],
      decided: state.decided,
      lane: state.lane,
      reply: EMPTY_REPLY,
      setReply: noop,
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
    state.queue = switchLane(state.queue, laneItems(items, next), next, state.decided, false);
  };
  return { state, calls, moves, switchTo };
}

describe("the title switcher", () => {
  test('the title reads "flow" in Everything and names the lane as the person typed it otherwise', () => {
    expect(laneTitle(null)).toBe("flow");
    expect(laneTitle(WORK)).toBe("flow · Work");
    const html = renderToStaticMarkup(createElement(DeckHeader, { lane: WORK, lanes: [WORK], items: [], needYou: 0, chats: 0, others: 0, onLane: noop }));
    expect(html).toContain("flow · Work");
    expect(html).toContain('aria-haspopup="menu"');
  });

  test("the menu lists Everything, the person's lanes, an agent lane for each agent with cards, then new lane…", () => {
    const items = [work, of("w2", "ag-work", "Ada"), home];
    const html = renderToStaticMarkup(createElement(LaneMenu, { lane: WORK, lanes: [WORK, HOME], items, onPick: noop, onNewLane: noop, onClose: noop }));
    expect(html).toContain('role="menu"');
    const rows = [...html.matchAll(/role="menuitem(?:radio)?"[^>]*>(.*?)<\/button>/g)].map((m) =>
      m[1]
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim(),
    );
    expect(rows).toEqual(["everything", "Work", "Home", "Ada 2", "Bo 1", "new lane…"]);
    expect(html.match(/aria-checked="true"/g)).toHaveLength(1);
    expect(html).toMatch(/aria-checked="true"[^>]*>.*?Work/);
  });

  test("no agent pills are left to render", () => {
    expect("AgentPills" in parts).toBe(false);
    expect("agentPills" in parts).toBe(false);
    const html = renderToStaticMarkup(createElement(DeckHeader, { lane: null, lanes: [], items: [work, home], needYou: 2, chats: 2, others: 0, onLane: noop }));
    expect(html).not.toContain("aria-pressed");
  });
});

describe("the deck in a lane", () => {
  // AE3: an approval outside Work stays out of Work's deck and only raises the quiet count.
  test("in Work an approval outside it is not in the deck and the quiet line counts it; Everything has no quiet line", () => {
    const asks = of("h2", "ag-home", "Bo", { status: "approval" });
    const items = [work, asks];
    expect(ids(inboxQueue(laneItems(items, WORK)))).toEqual(["w1"]);
    expect(otherLanesCount(items, WORK)).toBe(1);
    const inWork = renderToStaticMarkup(createElement(DeckHeader, { lane: WORK, lanes: [WORK], items, needYou: 0, chats: 1, others: 1, onLane: noop }));
    expect(inWork).toContain("1 waiting in other lanes");
    const all = renderToStaticMarkup(createElement(DeckHeader, { lane: null, lanes: [WORK], items, needYou: 1, chats: 2, others: 0, onLane: noop }));
    expect(all).not.toContain("other lanes");
  });

  test("switching from Everything to Work while a Work card is on top keeps it on top", () => {
    const d = deck([work, home, of("w2", "ag-work", "Ada")], null);
    d.switchTo(WORK, [work, home, of("w2", "ag-work", "Ada")]);
    expect(ids(d.state.queue)).toEqual(["w1", "w2"]);
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

describe("an emptied lane", () => {
  // AE6: Ada's lane cleared: caught up, the outside count, the way back; Ada's lane stays listed only while on.
  test("the caught-up state shows the other lanes' count and a way back to everything", () => {
    const html = renderToStaticMarkup(createElement(CaughtUp, { items: [], decided: [], replies: 0, others: 2, onEverything: noop }));
    expect(html).toContain("2 waiting in other lanes");
    expect(html).toContain("back to everything");
    const none = renderToStaticMarkup(createElement(CaughtUp, { items: [], decided: [], replies: 0, others: 0, onEverything: noop }));
    expect(none).not.toContain("other lanes");
    expect(none).toContain("back to everything");
    expect(renderToStaticMarkup(createElement(CaughtUp, { items: [], decided: [], replies: 0 }))).not.toContain("back to everything");
  });

  test("an emptied agent lane stays in the menu while on and leaves it once the person switches away", () => {
    const items = [home, of("w9", "ag-work", "Ada", { status: "running" })];
    const ada = agentLane(items, "ag-work");
    const on = renderToStaticMarkup(createElement(LaneMenu, { lane: ada, lanes: [], items, onPick: noop, onNewLane: noop, onClose: noop }));
    expect(on).toMatch(/aria-checked="true"[^>]*>.*?Ada/);
    const away = renderToStaticMarkup(createElement(LaneMenu, { lane: null, lanes: [], items, onPick: noop, onNewLane: noop, onClose: noop }));
    expect(away).not.toContain("Ada");
    expect(away).toContain("Bo");
  });
});

describe("analytics", () => {
  test("a lane switch reports the kind of lane, and the agent for an agent lane", () => {
    expect(laneEvent("")).toEqual({ kind: "everything", agent: null });
    expect(laneEvent(WORK.id)).toEqual({ kind: "own", agent: null });
    expect(laneEvent(agentLane([work], "ag-work").id)).toEqual({ kind: "agent", agent: "ag-work" });
  });
});
