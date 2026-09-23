import { describe, expect, test } from "bun:test";
import { boardViews, columnsOf, dispatchMessage, filterTasks, parseBoardView, stepCursor, viewColumns, type Task } from "../app/src/board/model.ts";

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
  test("a status the board does not know stays off it", () => {
    expect(columnsOf([t({ id: "x", status: "tombstone" })], NOW).flatMap((c) => c.tasks)).toEqual([]);
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

describe("board: views (the list column)", () => {
  const tasks = [
    t({ id: "a", priority: 3 }),
    t({ id: "b", priority: 1, assignee: "friday" }),
    t({ id: "c", status: "in_progress", assignee: "friday" }),
    t({ id: "d", status: "blocked", assignee: "ira" }),
    t({ id: "e", status: "deferred", priority: 0 }),
    t({ id: "f", status: "closed", closedAt: "2026-09-06T11:00:00Z", assignee: "friday" }),
    t({ id: "old", status: "closed", closedAt: "2026-08-01T00:00:00Z", assignee: "ira" }),
  ];
  const shown = (view: Parameters<typeof viewColumns>[1]) => viewColumns(tasks, view, NOW).flatMap((c) => c.tasks.map((x) => x.id));

  test("all tasks, then each status, then each agent that has tasks on the board, by name", () => {
    const { views, agents } = boardViews(tasks, NOW);
    expect(views.map((v) => [v.view, v.label, v.count])).toEqual([
      ["all", "All tasks", 6],
      ["open", "Open", 3],
      ["in_progress", "In progress", 1],
      ["blocked", "Blocked", 1],
      ["done", "Done · 7d", 1],
    ]);
    // ira's only other task closed a month ago: it is off the board, so it does not count.
    expect(agents.map((v) => [v.view, v.label, v.count])).toEqual([
      ["agent:friday", "friday", 3],
      ["agent:ira", "ira", 1],
    ]);
  });

  test("every count is the number of tasks its view shows", () => {
    const { views, agents } = boardViews(tasks, NOW);
    for (const v of [...views, ...agents]) expect(shown(v.view)).toHaveLength(v.count);
  });

  test("all keeps the four columns; a status is its one column; an agent is one list in board order", () => {
    expect(viewColumns(tasks, "all", NOW).map((c) => c.id)).toEqual(["open", "in_progress", "blocked", "done"]);
    expect(viewColumns(tasks, "blocked", NOW).map((c) => [c.id, c.tasks.map((x) => x.id)])).toEqual([["blocked", ["d"]]]);
    const friday = viewColumns(tasks, "agent:friday", NOW);
    expect(friday.map((c) => [c.id, c.label])).toEqual([["agent", "friday"]]);
    expect(shown("agent:friday")).toEqual(["b", "c", "f"]);
  });

  test("an agent with nothing left shows an empty list, not the board", () => {
    expect(viewColumns(tasks, "agent:nobody", NOW)).toEqual([{ id: "agent", label: "nobody", tasks: [] }]);
  });

  test("a stored view reads back, anything else is all", () => {
    expect(parseBoardView("blocked")).toBe("blocked");
    expect(parseBoardView("agent:friday")).toBe("agent:friday");
    expect(parseBoardView("agent:")).toBe("all");
    expect(parseBoardView("nope")).toBe("all");
    expect(parseBoardView(null)).toBe("all");
  });
});

describe("board: cursor keys over any view", () => {
  const tasks = [t({ id: "a" }), t({ id: "b" }), t({ id: "c", status: "in_progress" }), t({ id: "d", status: "blocked", assignee: "ira" }), t({ id: "e", status: "blocked" })];

  test("all: up and down within a column, sideways to the nearest non-empty column", () => {
    const cols = viewColumns(tasks, "all", NOW);
    expect(stepCursor(cols, null, "down")).toBe("a");
    expect(stepCursor(cols, "a", "down")).toBe("b");
    expect(stepCursor(cols, "b", "down")).toBeNull();
    expect(stepCursor(cols, "a", "up")).toBeNull();
    expect(stepCursor(cols, "b", "right")).toBe("c");
    expect(stepCursor(cols, "c", "right")).toBe("d");
    expect(stepCursor(cols, "d", "right")).toBeNull(); // done is empty and last
    expect(stepCursor(cols, "e", "left")).toBe("c");
  });

  test("a single list: the same up and down, and sideways (the column step) has nowhere to go", () => {
    const cols = viewColumns(tasks, "blocked", NOW);
    expect(stepCursor(cols, null, "down")).toBe("d");
    expect(stepCursor(cols, "d", "down")).toBe("e");
    expect(stepCursor(cols, "e", "up")).toBe("d");
    expect(stepCursor(cols, "d", "left")).toBeNull();
    expect(stepCursor(cols, "d", "right")).toBeNull();
    // A cursor left over from another view is not in this one: nowhere to step from.
    expect(stepCursor(cols, "a", "down")).toBeNull();
  });
});
