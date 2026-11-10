// The phone's Flow in a lane (plan 082, U7): the title names the lane and opens the sheet, the deck and its counts
// follow the lane, the quiet line counts the rest, and an emptied lane offers the way back to Everything.
import { describe, expect, test } from "vitest";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { AttentionItem } from "../core/attention/model.ts";
import { agentLaneId, laneItems, type Lane, type ResolvedLane } from "../core/attention/lanes.ts";
import { idOf } from "../core/attention/queue.ts";
import type { ChatFace, FlowLane } from "../core/attention/use-attention.ts";
import { LANE_KEYS, createActiveLaneStore } from "../app/src/shared/active-lane.ts";
import { Inbox, type Deck, type InboxMoves } from "../app/src/phone/inbox.tsx";
import { LaneTitle } from "../app/src/phone/lane-sheet.tsx";
import { EMPTY_DECK, commitCard, deckQueue, laneChoices, otherLanesLine, reconcileDeck } from "../app/src/phone/deck.ts";
import { attentionItem } from "./fixtures/attention.ts";

const work: Lane = { id: "work", name: "Work", chats: ["ada"], accounts: [] };
const home: Lane = { id: "home", name: "Home", chats: ["bo"], accounts: [] };
/** A lane of an agent with nothing in Flow. */
const quiet: Lane = { id: "quiet", name: "Quiet", chats: ["cy"], accounts: [] };
const chat = (id: string, agentId: string, over: Partial<AttentionItem> = {}) =>
  attentionItem(id, { agent_id: agentId, agent_name: agentId, runtime: { agent_id: agentId, conversation_id: id }, ...over });

// Two of Ada's chats (Work) and two of Bo's (Home), each waiting on the person.
const items = [chat("w1", "ada"), chat("w2", "ada"), chat("h1", "bo"), chat("h2", "bo")];

const flowIn = (lane: ResolvedLane | null): FlowLane => ({
  lane,
  laneId: lane?.id ?? "",
  setLaneId: () => {},
  lanes: [work, home, quiet],
  setLanes: null,
  laneItems: laneItems(items, lane),
});

const face: ChatFace = {
  status: "idle",
  pending: null,
  question: null,
  error: null,
  mode: null,
  cwd: null,
  engine: null,
  older: null,
  loadFailed: null,
  loadStep: () => Promise.resolve(null),
  suggestions: [],
  links: [],
};

const fakeDeck = (visible: AttentionItem[]): Deck => ({
  visible,
  current: visible.at(0),
  currentId: visible[0] ? idOf(visible[0]) : null,
  pass: EMPTY_DECK.pass,
  heldId: null,
  commit: () => true,
  undo: () => {},
  hold: () => {},
  dismissed: () => false,
  again: () => {},
  restingToo: () => {},
  resting: false,
});

const moves: InboxMoves = {
  read: () => Promise.resolve({ error: null, ask: false, rest: null }),
  later: () => Promise.resolve({ error: null, ask: false, rest: null }),
  archive: () => Promise.resolve(null),
  undo: () => Promise.resolve(null),
  laterAsks: () => false,
  label: () => Promise.resolve(null),
  labelsOf: () => Promise.resolve([]),
};

/** Draw an element as the phone's page would, with the browser globals it reads faked and put back after. */
function inPage(el: ReactElement): string {
  const g = globalThis as Record<string, unknown>;
  const saved = { window: g.window, localStorage: g.localStorage, location: g.location };
  g.window = {};
  g.localStorage = { getItem: () => null };
  g.location = { origin: "http://127.0.0.1:5191", href: "http://127.0.0.1:5191/" };
  try {
    return renderToStaticMarkup(el);
  } finally {
    Object.assign(g, saved);
  }
}

/** The phone's Inbox in a lane, over every item, with the lane's cards as its deck. */
function inbox(lane: ResolvedLane | null, visible: AttentionItem[]): string {
  const flow = flowIn(lane);
  return inPage(
    createElement(Inbox, {
      items,
      loaded: true,
      available: true,
      chats: { conversation: () => face, watchThreads: () => () => {}, threadRows: () => undefined, flow },
      deck: fakeDeck(visible),
      backLabel: "Home",
      onClose: () => {},
      onOpen: () => {},
      onConnection: () => {},
      onApprove: () => {},
      moves,
      onNote: () => {},
      card: { onSend: () => {}, onAnswer: () => {}, onCancelQueued: () => {} },
    }),
  );
}

describe("the title names the lane", () => {
  test("it reads Flow in Everything and the lane's name in a lane, in sentence case, and opens the lane sheet", () => {
    const plain = (el: ReactElement) => renderToStaticMarkup(el).replace(/<[^>]+>/g, "");
    expect(plain(createElement(LaneTitle, { lane: null, onOpen: () => {} }))).toBe("Flow");
    expect(plain(createElement(LaneTitle, { lane: work, onOpen: () => {} }))).toBe("Work");
    expect(plain(createElement(LaneTitle, { lane: { id: agentLaneId("ada"), name: "ada", agent_id: "ada", count: 2 }, onOpen: () => {} }))).toBe("Ada");
    expect(renderToStaticMarkup(createElement(LaneTitle, { lane: work, onOpen: () => {} }))).toContain('aria-haspopup="dialog"');
  });
  test("the Inbox's title is the lane in Work, with a card up and with none", () => {
    expect(inbox(work, laneItems(items, work))).toContain(">Work<");
    expect(inbox(work, [])).toContain(">Work<");
    expect(inbox(null, items)).toContain(">Flow<");
  });
});

describe("the lane sheet", () => {
  test("it lists Everything, then the person's lanes, then a built-in lane for each agent with cards", () => {
    const choices = laneChoices([work, home], [...items, chat("h3", "bo")]);
    expect(choices.map((c) => [c.id, c.name])).toEqual([
      ["", "Everything"],
      ["work", "Work"],
      ["home", "Home"],
      ["agent:bo", "bo"],
      ["agent:ada", "ada"],
    ]);
    expect(laneChoices(null, []).map((c) => c.id)).toEqual([""]);
  });
  test("picking a lane writes the phone's stored lane and leaves the Mac's alone", () => {
    const m = new Map<string, string>();
    const storage = () => ({ getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) }) as unknown as Storage;
    const phone = createActiveLaneStore("phone", storage);
    phone.set("work");
    expect(m.get(LANE_KEYS.phone)).toBe("work");
    expect(m.has(LANE_KEYS.desktop)).toBe(false);
  });
});

describe("Flow follows the lane", () => {
  test("in Work the header counts Work's cards and the quiet line counts the rest; Everything has no quiet line", () => {
    const html = inbox(work, laneItems(items, work));
    expect(html).toContain("2 need you");
    expect(html).toContain("2 waiting in other lanes");
    const all = inbox(null, items);
    expect(all).toContain("4 need you");
    expect(all).not.toContain("other lanes");
  });
  test("the quiet line is hidden at zero and says one card in the singular", () => {
    expect(otherLanesLine(0)).toBeNull();
    expect(otherLanesLine(1)).toBe("1 waiting in other lanes");
  });
  test("the card on top stays on top when the new lane holds it, and the visit's moves carry across", () => {
    // In Everything, w2 is on top (an undo or a reply pinned it there) and h1 was passed over.
    const pinned = { ...EMPTY_DECK, topId: idOf(items[1]) };
    const passed = commitCard(pinned, items[2], "later");
    const everything = reconcileDeck({ ...passed, topId: idOf(items[1]) }, items);
    expect(deckQueue(items, everything).map((i) => i.id)).toEqual(["w2", "w1", "h2"]);
    // Work holds w2: it stays on top.
    const workItems = laneItems(items, work);
    const inWork = reconcileDeck(everything, workItems, items);
    expect(deckQueue(workItems, inWork).map((i) => i.id)).toEqual(["w2", "w1"]);
    // Home does not: its own first card comes up, and h1, passed over in Everything, stays passed over.
    const homeItems = laneItems(items, home);
    const inHome = reconcileDeck(inWork, homeItems, items);
    expect(deckQueue(homeItems, inHome).map((i) => i.id)).toEqual(["h2"]);
    // Back in Everything, h1 is still passed over.
    const back = reconcileDeck(inHome, items, items);
    expect(deckQueue(items, back).map((i) => i.id)).not.toContain("h1");
  });
  test("an emptied lane shows the caught-up state, the other lanes' count and a way back to Everything", () => {
    const html = inbox(quiet, []);
    expect(html).toContain("caught up");
    expect(html).toContain("4 waiting in other lanes");
    expect(html).toContain("Back to Everything");
    expect(inbox(null, [])).not.toContain("Back to Everything");
  });
});
