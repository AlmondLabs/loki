import { describe, expect, test } from "bun:test";
import { homeDeskSections, homeSections } from "../app/src/phone/model.ts";

import type { AttentionItem } from "../core/attention/model.ts";
import type { DeskSummary } from "../core/frame-types.ts";

describe("Home's desks group as the desktop sidebar's (homeDeskSections)", () => {
  const desk = (scope: string, agentId: string, agentName: string, lastActive: string, extra: Partial<DeskSummary> = {}): DeskSummary => ({ scope, title: scope, status: "live", agentName, agentId, conversationId: scope, model: null, reasoningEffort: null, pinned: false, widgets: 0, active: false, lastActive, ...extra }) as DeskSummary;
  const desks = [
    desk("a1", "ira", "ira", "2026-09-25T10:00:00Z"),
    desk("default", "ira", "ira", "2026-09-20T10:00:00Z", { title: null }),
    desk("b1", "kai", "kai", "2026-09-25T12:00:00Z"),
    desk("b2", "kai", "kai", "2026-09-24T12:00:00Z", { pinned: true }),
    desk("c1", "juno", "juno", "2026-09-10T12:00:00Z", { status: "archived" }),
  ];
  const agents = [{ id: "ira", name: "ira" }, { id: "kai", name: "kai" }];

  test("Pinned first, then one section per agent by its latest activity, the main chat first; archived desks stay out", () => {
    const groups = homeDeskSections(desks, [], [], "", agents);
    expect(groups.map((g) => [g.id, g.rows.map((r) => r.desk.scope)])).toEqual([
      ["pinned", ["b2"]],
      ["agent:kai", ["b1"]],
      ["agent:ira", ["default", "a1"]],
    ]);
  });

  test("a conversation in Needs your attention is not repeated below, and an emptied section goes", () => {
    const item = { agentId: "kai", id: "b1", status: "question", unread: true, title: "b1", lastMessageAt: "2026-09-25T12:00:00Z" } as unknown as AttentionItem;
    const attention = [{ item, desk: desks[2] }];
    const groups = homeDeskSections(desks, [item], attention, "", agents);
    expect(groups.map((g) => g.id)).toEqual(["pinned", "agent:ira"]);
  });

  test("the filter narrows by desk name or agent name", () => {
    expect(homeDeskSections(desks, [], [], "kai", agents).map((g) => g.id)).toEqual(["pinned", "agent:kai"]);
    expect(homeDeskSections(desks, [], [], "a1", agents).flatMap((g) => g.rows.map((r) => r.desk.scope))).toEqual(["a1"]);
    expect(homeSections(desks, [], null, "").desks.length).toBeGreaterThan(0); // the attention half still comes from homeSections
  });
});
