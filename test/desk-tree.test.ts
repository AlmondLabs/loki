import { describe, expect, test } from "vitest";
import { archivedDesks, liveDesks } from "../app/src/shell/desk-tree.tsx";

import type { DeskSummary } from "../core/frame-types.ts";

/** The chat lists the phone shares (app/src/shell/desk-tree.tsx): live chats pinned first then by last message, and the archive. */

const desk = (scope: string, over: Partial<DeskSummary> = {}): DeskSummary =>
  ({
    scope,
    title: scope,
    status: "live",
    agent_name: "friday",
    agent_id: "a1",
    conversation_id: scope,
    model: null,
    pinned: false,
    widgets: 0,
    active: false,
    last_active: "2026-09-08T10:00:00Z",
    ...over,
  }) as DeskSummary;

const desks = [
  desk("jira", { last_active: "2026-09-08T12:00:00Z" }),
  desk("aws", { last_active: "2026-09-08T11:00:00Z" }),
  desk("email", { pinned: true, last_active: "2026-09-07T09:00:00Z" }),
  desk("cost", { last_active: "2026-09-08T09:00:00Z" }),
  desk("old", { last_active: "2026-09-01T09:00:00Z" }),
  desk("gone", { status: "archived" }),
  desk("shared", { title: "shared sheet" }),
];

describe("the chat lists", () => {
  test("live: pinned first, then by last message; shared and archived out", () => {
    expect(liveDesks(desks, null, "").map((d) => d.scope)).toEqual(["email", "jira", "aws", "cost", "old"]);
  });
  test("the agent filter and the query narrow it", () => {
    const mixed = [...desks, desk("ira-main", { agent_id: "a2", agent_name: "ira", pinned: true })];
    expect(liveDesks(mixed, "a2", "").map((d) => d.scope)).toEqual(["ira-main"]);
    expect(liveDesks(desks, null, "aw").map((d) => d.scope)).toEqual(["aws"]);
  });
  test("archived: what is not live", () => {
    expect(archivedDesks(desks, null, "").map((d) => d.scope)).toEqual(["gone"]);
  });
});
