import { describe, expect, test } from "bun:test";
import { columnsOf, dispatchMessage, filterTasks, type Task } from "../app/src/board/model.ts";

const t = (over: Partial<Task>): Task => ({ id: "lk-a1", title: "rotate SSO creds", description: "", status: "open", priority: 2, labels: [], assignee: null, createdAt: "2026-09-06T10:00:00Z", updatedAt: "2026-09-06T10:00:00Z", closedAt: null, metadata: {}, ...over });
const NOW = new Date("2026-09-06T12:00:00Z").getTime();

describe("board: columns", () => {
  test("statuses land in their columns; open sorts by priority then recency", () => {
    const cols = columnsOf(
      [t({ id: "a", priority: 3 }), t({ id: "b", priority: 1 }), t({ id: "c", status: "in_progress" }), t({ id: "d", status: "blocked" }), t({ id: "e", status: "deferred", priority: 0 }), t({ id: "f", status: "closed", closedAt: "2026-09-06T11:00:00Z" })],
      NOW,
    );
    expect(cols.map((c) => c.tasks.map((x) => x.id))).toEqual([["e", "b", "a"], ["c"], ["d"], ["f"]]);
  });
  test("done keeps only the last week", () => {
    const cols = columnsOf([t({ id: "old", status: "closed", closedAt: "2026-08-01T00:00:00Z" }), t({ id: "new", status: "closed", closedAt: "2026-09-05T00:00:00Z" })], NOW);
    expect(cols[3].tasks.map((x) => x.id)).toEqual(["new"]);
  });
  test("filter matches title, id, label, and filer", () => {
    const tasks = [t({ id: "lk-a1", title: "rotate creds", labels: ["aws"], metadata: { agent: "friday" } }), t({ id: "lk-b2", title: "write plan", labels: ["almonds"], metadata: { agent: "ira" } })];
    expect(filterTasks(tasks, "AWS").map((x) => x.id)).toEqual(["lk-a1"]);
    expect(filterTasks(tasks, "ira").map((x) => x.id)).toEqual(["lk-b2"]);
    expect(filterTasks(tasks, "b2").map((x) => x.id)).toEqual(["lk-b2"]);
    expect(filterTasks(tasks, "  ")).toHaveLength(2);
  });
});

describe("board: dispatch message", () => {
  test("one task, with description, source and closing instructions", () => {
    const msg = dispatchMessage([t({ description: "before the audit\nsee the runbook", metadata: { by: "agent", agent: "friday", folder: "/Users/x/infra" } })]);
    expect(msg).toContain("Please pick up this task from my board:");
    expect(msg).toContain("- lk-a1 · P2 · rotate SSO creds (filed by friday, in /Users/x/infra)");
    expect(msg).toContain("  before the audit\n  see the runbook");
    expect(msg).toContain("loki_task");
  });
  test("several tasks are numbered as a batch and filed-by-me reads naturally", () => {
    const msg = dispatchMessage([t({ metadata: { by: "you" } }), t({ id: "lk-b2", title: "second", priority: 0 })]);
    expect(msg).toContain("these 2 tasks");
    expect(msg).toContain("(filed by me)");
    expect(msg).toContain("- lk-b2 · P0 · second");
    expect(msg).toContain("Work them in order");
  });
});
