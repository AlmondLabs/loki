import { describe, expect, test } from "bun:test";
import { initialIndex, sectionDesks, statusLine, treeKey } from "../app/src/shell/DeskTree.tsx";
import type { DeskSummary } from "../app/src/desk/useDesk";
import type { AttentionItem } from "../core/attention/model.ts";

/**
 * The switcher's order (app/src/shell/DeskTree.tsx): waiting on you, pinned, recent in visit order,
 * the rest by last message — each desk once — and the row the highlight starts on: the desk before
 * this one, so ⌘K ↵ goes back.
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
  test("waiting, pinned, recent in visit order, then the rest by last message; each desk once; shared and archived out", () => {
    const secs = sectionDesks(desks, null, [item("cost", "approval"), item("jira", "done")], ["aws", "cost", "old"]);
    expect(secs.map((s) => [s.id, s.desks.map((d) => d.scope)])).toEqual([
      ["waiting", ["cost"]],
      ["pinned", ["email"]],
      ["recent", ["aws", "old"]], // cost already placed under waiting
      ["rest", ["jira"]],
    ]);
    expect(secs.find((s) => s.id === "waiting")?.label).toBe("waiting on you");
    expect(secs.find((s) => s.id === "rest")?.label).toBe("everything else");
  });
  test("nothing waiting, nothing pinned, nothing visited: one section, by last message, labelled plainly", () => {
    const secs = sectionDesks(desks.map((d) => ({ ...d, pinned: false })), null, [], []);
    expect(secs).toHaveLength(1);
    expect(secs[0].label).toBe("desks");
    expect(secs[0].desks.map((d) => d.scope)).toEqual(["jira", "aws", "cost", "email", "old"]);
  });
  test("the agent filter applies inside every section", () => {
    const mixed = [...desks, desk("ira-main", { agentId: "a2", agentName: "ira", pinned: true })];
    const secs = sectionDesks(mixed, "a2", [], ["jira"]);
    expect(secs.flatMap((s) => s.desks.map((d) => d.scope))).toEqual(["ira-main"]);
  });
  test("recent is capped at eight and only lists live desks that still exist", () => {
    const many = Array.from({ length: 12 }, (_, i) => desk(`d${i}`, { lastActive: `2026-09-0${(i % 9) + 1}T00:00:00Z` }));
    const secs = sectionDesks(many, null, [], [...many.map((d) => d.scope), "vanished"]);
    expect(secs.find((s) => s.id === "recent")?.desks).toHaveLength(8);
    expect(secs.find((s) => s.id === "rest")?.desks).toHaveLength(4);
  });
});

describe("where the highlight starts", () => {
  const rows = ["cost", "email", "aws", "old", "jira", null];
  test("the desk before this one, so enter goes back", () => {
    expect(initialIndex(rows, ["jira", "aws", "cost"], "jira")).toBe(2);
  });
  test("no previous desk: the current one", () => {
    expect(initialIndex(rows, ["jira"], "jira")).toBe(4);
    expect(initialIndex(rows, [], "jira")).toBe(4);
  });
  test("the previous desk is gone or filtered out: the current one; nothing matches: the top", () => {
    expect(initialIndex(rows, ["jira", "vanished"], "jira")).toBe(4);
    expect(initialIndex(rows, ["x", "y"], "x")).toBe(0);
  });
});

describe("the filter box's keys", () => {
  const key = (k: string, mods: Partial<{ shift: boolean; meta: boolean; ctrl: boolean }> = {}) => ({ key: k, shiftKey: !!mods.shift, metaKey: !!mods.meta, ctrlKey: !!mods.ctrl });
  const all = { pin: true, archive: true };
  test("arrows move, tab cycles agents, enter opens (shift: with the chat), escape closes", () => {
    expect(treeKey(key("ArrowDown"), all)).toBe("down");
    expect(treeKey(key("ArrowUp"), all)).toBe("up");
    expect(treeKey(key("Tab"), all)).toBe("agent-next");
    expect(treeKey(key("Tab", { shift: true }), all)).toBe("agent-prev");
    expect(treeKey(key("Enter"), all)).toBe("choose");
    expect(treeKey(key("Enter", { shift: true }), all)).toBe("choose-chat");
    expect(treeKey(key("Escape"), all)).toBe("close");
  });
  test("⌘P and ⌘E (or ctrl) only when the sheet can pin or archive; shifted or plain letters stay with the input", () => {
    expect(treeKey(key("p", { meta: true }), all)).toBe("pin");
    expect(treeKey(key("e", { ctrl: true }), all)).toBe("archive");
    expect(treeKey(key("P", { meta: true, shift: true }), all)).toBeNull();
    expect(treeKey(key("p"), all)).toBeNull();
    expect(treeKey(key("p", { meta: true }), { pin: false, archive: true })).toBeNull();
    expect(treeKey(key("e", { meta: true }), { pin: true, archive: false })).toBeNull();
    expect(treeKey(key("k", { meta: true }), all)).toBeNull();
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
