import { describe, expect, test } from "vitest";
import { homeDeskSections, homeLists, homeSections } from "../app/src/phone/model.ts";

import type { AttentionItem } from "../core/attention/model.ts";
import type { DeskSummary } from "../core/frame-types.ts";

describe("Home's desks group as the desktop sidebar's (homeDeskSections)", () => {
  const desk = (scope: string, agentId: string, agentName: string, lastActive: string, extra: Partial<DeskSummary> = {}): DeskSummary => ({
    scope,
    title: scope,
    status: "live",
    agent_name: agentName,
    agent_id: agentId,
    conversation_id: scope,
    model: null,
    reasoning_effort: null,
    pinned: false,
    widgets: 0,
    active: false,
    last_active: lastActive,
    ...extra,
  });
  const desks = [
    desk("a1", "ira", "ira", "2026-09-25T10:00:00Z"),
    desk("default", "ira", "ira", "2026-09-20T10:00:00Z", { title: null }),
    desk("b1", "kai", "kai", "2026-09-25T12:00:00Z"),
    desk("b2", "kai", "kai", "2026-09-24T12:00:00Z", { pinned: true }),
    desk("c1", "juno", "juno", "2026-09-10T12:00:00Z", { status: "archived" }),
  ];
  const agents = [
    { id: "ira", name: "ira" },
    { id: "kai", name: "kai" },
  ];

  test("Pinned first, then one section per agent by its latest activity, the main chat first; archived desks stay out", () => {
    const groups = homeDeskSections(desks, [], [], "", agents);
    expect(groups.map((g) => [g.id, g.rows.map((r) => r.desk.scope)])).toEqual([
      ["pinned", ["b2"]],
      ["agent:kai", ["b1"]],
      ["agent:ira", ["default", "a1"]],
    ]);
  });

  test("a conversation in Needs your attention is not repeated below, and an emptied section goes", () => {
    const item = {
      agent_id: "kai",
      id: "b1",
      status: "question",
      unread: true,
      title: "b1",
      last_message_at: "2026-09-25T12:00:00Z",
    } as unknown as AttentionItem;
    const attention = [{ item, desk: desks[2], opens: "chat" as const }];
    const groups = homeDeskSections(desks, [item], attention, "", agents);
    expect(groups.map((g) => g.id)).toEqual(["pinned", "agent:ira"]);
  });

  test("the filter narrows by desk name or agent name", () => {
    expect(homeDeskSections(desks, [], [], "kai", agents).map((g) => g.id)).toEqual(["pinned", "agent:kai"]);
    expect(homeDeskSections(desks, [], [], "a1", agents).flatMap((g) => g.rows.map((r) => r.desk.scope))).toEqual(["a1"]);
    expect(homeSections(desks, [], null, "").desks.length).toBeGreaterThan(0); // the attention half still comes from homeSections
  });
});

describe("Home under the phone's lane (plan 085, R15, R16)", () => {
  const desk = (scope: string, agentId: string): DeskSummary => ({
    scope,
    title: scope,
    status: "live",
    agent_name: agentId,
    agent_id: agentId,
    conversation_id: scope,
    model: null,
    reasoning_effort: null,
    pinned: false,
    widgets: 0,
    active: false,
    last_active: "2026-09-25T10:00:00Z",
  });
  const asks = (id: string, agentId: string) =>
    ({ agent_id: agentId, id, status: "question", unread: true, title: id, last_message_at: "2026-09-25T12:00:00Z" }) as unknown as AttentionItem;
  const desks = [desk("w1", "ada"), desk("h1", "bo")];
  const agents = [
    { id: "ada", name: "ada" },
    { id: "bo", name: "bo" },
  ];
  const items = [asks("w1", "ada"), asks("h1", "bo")];

  test("Needs your attention and its count hold only the lane's cards; the chat groups still list a chat outside it", () => {
    const home = homeLists({ desks, items, laneItems: [items[0]], query: "", agents, due: 0 });
    expect(home.attention.map((a) => a.item.id)).toEqual(["w1"]);
    expect(home.counts.inbox).toBe(1);
    expect(home.groups.flatMap((g) => g.rows.map((r) => r.desk.scope))).toEqual(["h1"]);
  });
  test("in Everything both cards need the person and neither repeats below", () => {
    const home = homeLists({ desks, items, laneItems: items, query: "", agents, due: 0 });
    expect(home.attention.map((a) => a.item.id).sort()).toEqual(["h1", "w1"]);
    expect(home.counts.inbox).toBe(2);
    expect(home.groups).toEqual([]);
  });
});
