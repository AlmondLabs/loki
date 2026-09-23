import { describe, expect, test } from "bun:test";
import { sectionDesks, statusLine, treeKey } from "../app/src/shell/DeskTree.tsx";
import type { DeskSummary } from "../app/src/desk/useDesk";
import type { AttentionItem } from "../core/attention/model.ts";

/**
 * The desk tree's order (app/src/shell/DeskTree.tsx), now only the Board's assign-to-desk picker (the
 * sidebar lists desks, ⌘K searches them): waiting on you, pinned, the rest by last message — each desk
 * once — and the picker's keys.
 */

const desk = (scope: string, over: Partial<DeskSummary> = {}): DeskSummary =>
  ({ scope: scope as DeskSummary["scope"], title: scope, status: "live", agentName: "friday", agentId: "a1", conversationId: scope, model: null, pinned: false, widgets: 0, active: false, lastActive: "2026-09-08T10:00:00Z", ...over }) as DeskSummary;
const item = (id: string, status: AttentionItem["status"]): AttentionItem => ({ id, agentId: "a1", status }) as unknown as AttentionItem;

const desks = [
  desk("jira", { lastActive: "2026-09-08T12:00:00Z" }),
  desk("aws", { lastActive: "2026-09-08T11:00:00Z" }),
  desk("email", { pinned: true, lastActive: "2026-09-07T09:00:00Z" }),
  desk("cost", { lastActive: "2026-09-08T09:00:00Z" }),
  desk("old", { lastActive: "2026-09-01T09:00:00Z" }),
  desk("gone", { status: "archived" }),
  desk("shared", { title: "shared sheet" }),
];

describe("sections", () => {
  test("waiting, pinned, then the rest by last message; each desk once; shared and archived out", () => {
    const secs = sectionDesks(desks, null, [item("cost", "approval"), item("jira", "done")]);
    expect(secs.map((s) => [s.id, s.desks.map((d) => d.scope)])).toEqual([
      ["waiting", ["cost"]],
      ["pinned", ["email"]],
      ["rest", ["jira", "aws", "old"]],
    ]);
    expect(secs.find((s) => s.id === "waiting")?.label).toBe("Waiting on you");
    expect(secs.find((s) => s.id === "rest")?.label).toBe("Everything else");
  });
  test("nothing waiting, nothing pinned: one section, by last message, labelled plainly", () => {
    const secs = sectionDesks(desks.map((d) => ({ ...d, pinned: false })), null, []);
    expect(secs).toHaveLength(1);
    expect(secs[0].label).toBe("Desks");
    expect(secs[0].desks.map((d) => d.scope)).toEqual(["jira", "aws", "cost", "email", "old"]);
  });
  test("the agent filter applies inside every section", () => {
    const mixed = [...desks, desk("ira-main", { agentId: "a2", agentName: "ira", pinned: true })];
    const secs = sectionDesks(mixed, "a2", []);
    expect(secs.flatMap((s) => s.desks.map((d) => d.scope))).toEqual(["ira-main"]);
  });
});

describe("the filter box's keys", () => {
  const key = (k: string, shift = false) => ({ key: k, shiftKey: shift });
  test("arrows move, tab cycles agents, enter chooses, escape closes", () => {
    expect(treeKey(key("ArrowDown"))).toBe("down");
    expect(treeKey(key("ArrowUp"))).toBe("up");
    expect(treeKey(key("Tab"))).toBe("agent-next");
    expect(treeKey(key("Tab", true))).toBe("agent-prev");
    expect(treeKey(key("Enter"))).toBe("choose");
    expect(treeKey(key("Escape"))).toBe("close");
  });
  test("anything else stays with the input: letters, and ⇧↵ (the drawer's open-with-chat went with it)", () => {
    expect(treeKey(key("p"))).toBeNull();
    expect(treeKey(key("Enter", true))).toBeNull();
  });
});

describe("the live region's words", () => {
  const chips = [{ id: "a1", name: "friday", count: 3 }, { id: "a2", name: null, count: 0 }];
  test("all agents, or the agent and its desk count; while typing, how many match", () => {
    expect(statusLine(null, chips, "", 5)).toBe("all agents");
    expect(statusLine("a1", chips, "", 5)).toBe("friday · 3 desks");
    expect(statusLine("a2", chips, "", 5)).toBe("agent · 0 desks");
    expect(statusLine(null, chips, "ji", 1)).toBe("all agents · 1 desk match");
    expect(statusLine("a1", chips, "ji", 2)).toBe("friday · 3 desks · 2 desks match");
  });
});
