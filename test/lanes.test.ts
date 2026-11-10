import { describe, expect, test } from "vitest";
import type { AttentionItem } from "../core/attention/model.ts";
import { agentLane, agentLanes, agentLaneId, inLane, parseLanes, laneItems, otherLanesCount, type Lane } from "../core/attention/lanes.ts";
import { attentionItem } from "./fixtures/attention.ts";
import { must } from "./fixtures/must.ts";
import { outsideItem } from "./fixtures/outside-item.ts";

/** Lanes (plan 087, U2): which cards a lane holds, the quiet count of the others, and the agents' built-in lanes. */

const GMAIL = "gmail:ada@acme.com";
const SLACK = "slack:T1:U1";

const chat = (id: string, agentId: string, over: Partial<AttentionItem> = {}) => attentionItem(id, { agent_id: agentId, ...over });
const mail = (id: string, accountId: string, ownerAgentId: string, over: Partial<AttentionItem> = {}): AttentionItem => {
  const base = outsideItem(id);
  return {
    ...base,
    id,
    agent_id: `account:${accountId}`,
    outside: {
      ...must(base.outside, "the fixture's outside facts"),
      account_id: accountId,
      provider: accountId.startsWith("slack:") ? "slack" : "gmail",
      owner_agent_id: ownerAgentId,
    },
    ...over,
  };
};
const lane = (over: Partial<Lane> = {}): Lane => ({ id: "l1", name: "Work", chats: "all", accounts: "all", ...over });
const ids = (items: AttentionItem[]) => items.map((i) => i.id);

describe("which cards a lane holds", () => {
  test("AE1: no chats and Ada's two accounts hold her mail and Slack cards and none of her chats", () => {
    const items = [chat("c1", "ada"), mail("m1", GMAIL, "ada"), mail("s1", SLACK, "ada"), mail("m2", "gmail:bo@acme.com", "bo")];
    expect(ids(laneItems(items, lane({ chats: [], accounts: [GMAIL, SLACK] })))).toEqual(["m1", "s1"]);
  });
  test("AE2: chats from all agents hold a chat from an agent never seen; picked agents do not hold another's chat", () => {
    expect(inLane(chat("c", "agent-new"), lane({ chats: "all", accounts: [] }))).toBe(true);
    expect(inLane(chat("c", "c"), lane({ chats: ["a", "b"], accounts: [] }))).toBe(false);
    expect(inLane(chat("a1", "a"), lane({ chats: ["a", "b"], accounts: [] }))).toBe(true);
  });
  test("an agent picked but gone holds nothing for that id, and nothing throws", () => {
    const work = lane({ chats: ["gone"], accounts: ["gmail:gone@acme.com"] });
    expect(laneItems([chat("c", "ada"), mail("m", GMAIL, "ada")], work)).toEqual([]);
  });
  test("Everything holds every card", () => {
    const items = [chat("c", "ada"), mail("m", GMAIL, "ada")];
    expect(laneItems(items, null)).toBe(items);
  });
  test("an agent's built-in lane holds its chats and the cards of accounts it owns, a paired Mac's account too", () => {
    const paired = mail("p", "gmail:ada@home.com", "ada", { home: "mac-2" });
    const items = [chat("c", "ada"), mail("m", GMAIL, "ada"), paired, chat("x", "bo"), mail("y", SLACK, "bo")];
    expect(ids(laneItems(items, agentLane(items, "ada")))).toEqual(["c", "m", "p"]);
  });
});

describe("the quiet count of cards waiting in other lanes", () => {
  test("AE3: an approval on an agent outside Work counts once and is not in Work's cards", () => {
    const work = lane({ chats: ["ada"], accounts: [] });
    const asks = chat("q", "bo", { status: "approval" });
    const items = [chat("c", "ada"), asks];
    expect(otherLanesCount(items, work)).toBe(1);
    expect(ids(laneItems(items, work))).toEqual(["c"]);
  });
  test("a card in two other lanes is counted once; Everything has none", () => {
    const items = [chat("c", "ada"), chat("q", "bo"), mail("m", GMAIL, "bo")];
    expect(otherLanesCount(items, lane({ chats: ["ada"], accounts: [] }))).toBe(2);
    expect(otherLanesCount(items, null)).toBe(0);
  });
});

describe("the agents' built-in lanes", () => {
  test("one per agent with cards, busiest first, then by name, a chat naming its agent", () => {
    const items = [chat("a", "ag-2", { agent_name: "Scout" }), chat("b", "ag-1", { agent_name: "Atlas" }), chat("c", "ag-2", { agent_name: "Scout" })];
    expect(agentLanes(items).map((l) => [l.id, l.name, l.count])).toEqual([
      [agentLaneId("ag-2"), "Scout", 2],
      [agentLaneId("ag-1"), "Atlas", 1],
    ]);
  });
  test("a card from an agent's account files under the agent; a mid-turn chat earns no lane", () => {
    const card = mail("o", SLACK, "agent-work", {
      agent_name: "farmart (Slack)",
      outside: { ...must(mail("o", SLACK, "agent-work").outside, "outside facts"), owner_name: "friday" },
    });
    expect(agentLanes([chat("c", "agent-work", { agent_name: "friday" }), card]).map((l) => [l.agent_id, l.name, l.count])).toEqual([
      ["agent-work", "friday", 2],
    ]);
    expect(agentLanes([card]).map((l) => l.name)).toEqual(["friday"]);
    expect(agentLanes([chat("r", "ag-1", { status: "running" })])).toEqual([]);
  });
  test("an agent's lane worked through stays with a count of 0 and its name", () => {
    expect(agentLane([chat("r", "ag-1", { agent_name: "Atlas", status: "running" })], "ag-1")).toEqual({
      id: agentLaneId("ag-1"),
      name: "Atlas",
      agent_id: "ag-1",
      count: 0,
    });
  });
});

describe("lanes from the wire", () => {
  test("a lane with no name or a bad side is dropped and the rest kept", () => {
    const good = lane({ id: "l2", name: "Home", chats: [], accounts: [GMAIL] });
    const raw: unknown = [
      good,
      { ...good, id: "l3", name: "" },
      { id: "l4", chats: "all", accounts: "all" },
      { ...good, id: "l5", chats: "some" },
      { ...good, id: "l6", accounts: [1] },
      { ...good, id: "" },
      null,
    ];
    expect(parseLanes(raw)).toEqual([good]);
    expect(parseLanes({ lanes: [] })).toEqual([]);
  });
});
