import { describe, expect, test } from "vitest";
import type { AttentionItem } from "../core/attention/model.ts";
import { agentLaneId, laneItems, type Lane } from "../core/attention/lanes.ts";
import { catchUpQueue } from "../core/attention/queue.ts";
import { LANE_KEYS, createActiveLaneStore, resolveLane } from "../app/src/shared/active-lane.ts";
import { attentionItem } from "./fixtures/attention.ts";

/** The active lane per device (plan 082, U5): what is kept, how it reads, and what the badges then count. */

const work: Lane = { id: "work", name: "Work", chats: ["ada"], accounts: [] };
const home: Lane = { id: "home", name: "Home", chats: ["bo"], accounts: [] };
const chat = (id: string, agentId: string, over: Partial<AttentionItem> = {}) => attentionItem(id, { agent_id: agentId, agent_name: agentId, ...over });
const agents = [
  { id: "ada", name: "Ada" },
  { id: "bo", name: "Bo" },
];

const memory = (seed: Record<string, string> = {}) => {
  const m = new Map(Object.entries(seed));
  const storage = {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
  } as unknown as Storage;
  return { storage, m };
};

describe("which lane a stored id reads as", () => {
  test("an id naming a lane that exists is that lane", () => {
    expect(resolveLane([work, home], [], agents, "home")).toBe(home);
  });
  test("an unknown id is Everything once lanes have loaded, and Everything while they are still null", () => {
    expect(resolveLane([work], [], agents, "gone")).toBeNull();
    expect(resolveLane(null, [], agents, "work")).toBeNull();
  });
  test("no stored value is Everything", () => {
    expect(resolveLane([work], [], agents, "")).toBeNull();
  });
  test("an agent's built-in lane resolves while the agent exists, even with no cards, and is Everything once it is gone", () => {
    const lane = resolveLane([], [], agents, agentLaneId("ada"));
    expect(lane).toEqual({ id: "agent:ada", name: "Ada", agent_id: "ada", count: 0 });
    expect(resolveLane(null, [], agents, agentLaneId("ada"))).toEqual(lane);
    expect(resolveLane([], [], agents, agentLaneId("gone"))).toBeNull();
  });
  test("an agent's built-in lane with cards counts them", () => {
    const items = [chat("c1", "ada", { status: "question" }), chat("c2", "bo", { status: "question" })];
    expect(resolveLane([], items, agents, agentLaneId("ada"))).toMatchObject({ agent_id: "ada", count: 1 });
  });
});

describe("the stored id on each device", () => {
  test("the desktop and the phone keep theirs under their own keys", () => {
    expect(LANE_KEYS).toEqual({ desktop: "loki.desktop.lane", phone: "loki.phone.lane" });
    const { storage, m } = memory();
    const desktop = createActiveLaneStore("desktop", () => storage);
    const phone = createActiveLaneStore("phone", () => storage);
    desktop.set("work");
    expect(m.get("loki.desktop.lane")).toBe("work");
    expect(phone.get()).toBe("");
  });
  test("a new device starts in Everything, and what was kept comes back", () => {
    expect(createActiveLaneStore("phone", () => memory().storage).get()).toBe("");
    expect(createActiveLaneStore("phone", () => memory({ "loki.phone.lane": "home" }).storage).get()).toBe("home");
  });
  test("storage that throws reads as Everything", () => {
    const broken = () => {
      throw new Error("no storage");
    };
    expect(createActiveLaneStore("desktop", broken).get()).toBe("");
  });
  test("reading the lanes while they are null does not touch what was kept", () => {
    const { storage, m } = memory({ "loki.desktop.lane": "work" });
    const store = createActiveLaneStore("desktop", () => storage);
    expect(resolveLane(null, [], agents, store.get())).toBeNull();
    expect(m.get("loki.desktop.lane")).toBe("work");
    expect(resolveLane([work], [], agents, store.get())).toBe(work);
  });
});

describe("the badges count the active lane (AE4)", () => {
  const items = [
    chat("w", "ada", { status: "question" }),
    chat("h1", "bo", { status: "approval" }),
    chat("h2", "bo", { status: "failed" }),
    chat("x", "bo", { status: "running" }),
  ];
  const waiting = (id: string) => catchUpQueue(laneItems(items, resolveLane([work, home], items, agents, id))).length;
  test("three need the person, one of them in Work: 1 with Work active, 3 in Everything", () => {
    expect(waiting("work")).toBe(1);
    expect(waiting("")).toBe(3);
  });
});
