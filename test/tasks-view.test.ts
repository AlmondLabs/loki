import { describe, expect, test } from "vitest";
import {
  DEFAULT_PREFS,
  boardColumns,
  cellText,
  columnsOf,
  dispatchMessage,
  filterTasks,
  folderName,
  isMine,
  isWaiting,
  missingAgentLine,
  nextSort,
  parsePrefs,
  parseTaskView,
  resolveTaskView,
  stepCursor,
  tableRows,
  taskViews,
  viewTasks,
  type Sort,
  type TaskViewId,
} from "../app/src/tasks/model.ts";
import type { Task } from "../core/frame-types.ts";

const t = (over: Partial<Task>): Task => ({
  id: "lk-a1",
  title: "rotate SSO creds",
  description: "",
  status: "open",
  priority: 2,
  labels: [],
  assignee: null,
  createdAt: "2026-09-06T10:00:00Z",
  updatedAt: "2026-09-06T10:00:00Z",
  closedAt: null,
  metadata: {},
  ...over,
});
const NOW = new Date("2026-09-06T12:00:00Z").getTime();

describe("tasks: columns", () => {
  test("statuses land in their columns; open sorts by priority then recency", () => {
    const cols = columnsOf(
      [
        t({ id: "a", priority: 3 }),
        t({ id: "b", priority: 1 }),
        t({ id: "c", status: "in_progress" }),
        t({ id: "d", status: "blocked" }),
        t({ id: "e", status: "deferred", priority: 0 }),
        t({ id: "f", status: "closed", closedAt: "2026-09-06T11:00:00Z" }),
      ],
      NOW,
    );
    expect(cols.map((c) => c.tasks.map((x) => x.id))).toEqual([["e", "b", "a"], ["c"], ["d"], ["f"]]);
  });
  test("a status the task list does not know stays off it", () => {
    expect(columnsOf([t({ id: "x", status: "tombstone" })], NOW).flatMap((c) => c.tasks)).toEqual([]);
  });
  test("done keeps only the last week", () => {
    const cols = columnsOf(
      [t({ id: "old", status: "closed", closedAt: "2026-08-01T00:00:00Z" }), t({ id: "new", status: "closed", closedAt: "2026-09-05T00:00:00Z" })],
      NOW,
    );
    expect(cols[3].tasks.map((x) => x.id)).toEqual(["new"]);
  });
  test("filter matches title, id, label, and filer", () => {
    const tasks = [
      t({ id: "lk-a1", title: "rotate creds", labels: ["aws"], metadata: { agent: "friday" } }),
      t({ id: "lk-b2", title: "write plan", labels: ["almonds"], metadata: { agent: "ira" } }),
    ];
    expect(filterTasks(tasks, "AWS").map((x) => x.id)).toEqual(["lk-a1"]);
    expect(filterTasks(tasks, "ira").map((x) => x.id)).toEqual(["lk-b2"]);
    expect(filterTasks(tasks, "b2").map((x) => x.id)).toEqual(["lk-b2"]);
    expect(filterTasks(tasks, "  ")).toHaveLength(2);
  });
});

describe("tasks: dispatch message", () => {
  test("one task, with description, source and closing instructions", () => {
    const msg = dispatchMessage([
      t({ description: "before the audit\nsee the runbook", metadata: { by: "agent", agent: "friday", folder: "/Users/x/infra" } }),
    ]);
    expect(msg).toContain("Please pick up this task from my task list:");
    expect(msg).toContain("- lk-a1 · P2 · rotate SSO creds (filed by friday, in /Users/x/infra)");
    expect(msg).toContain("  before the audit\n  see the runbook");
    expect(msg).toContain("tasks");
  });
  test("several tasks are numbered as a batch and filed-by-me reads naturally", () => {
    const msg = dispatchMessage([t({ metadata: { by: "you" } }), t({ id: "lk-b2", title: "second", priority: 0 })]);
    expect(msg).toContain("these 2 tasks");
    expect(msg).toContain("(filed by me)");
    expect(msg).toContain("- lk-b2 · P0 · second");
    expect(msg).toContain("Work them in order");
  });
});

describe("tasks: views (the sidebar)", () => {
  const tasks = [
    t({ id: "a", priority: 3, metadata: { by: "you" } }),
    t({ id: "b", priority: 1, assignee: "friday", metadata: { by: "you", assignedTo: "c1" } }),
    t({
      id: "c",
      status: "in_progress",
      assignee: "friday",
      metadata: { by: "agent", agent: "friday", assignedTo: "c1", doneAsked: "migrated staging", doneAskedBy: "friday" },
    }),
    t({ id: "d", status: "blocked", assignee: "ira", metadata: { by: "agent", agent: "ira" } }),
    t({ id: "e", status: "deferred", priority: 0, metadata: { by: "you" } }),
    t({ id: "f", status: "closed", closedAt: "2026-09-06T11:00:00Z", assignee: "friday", metadata: { doneAsked: "old word" } }),
    t({ id: "old", status: "closed", closedAt: "2026-08-01T00:00:00Z", assignee: "ira" }),
  ];
  const ids = (view: TaskViewId) => viewTasks(tasks, view, NOW).map((x) => x.id);

  test("All, Mine, Waiting for you, then each agent that has tasks, by name", () => {
    const { views, agents } = taskViews(tasks, NOW);
    expect(views.map((v) => [v.view, v.label, v.count])).toEqual([
      ["all", "All", 6],
      ["mine", "Mine", 2],
      ["waiting", "Waiting for you", 1],
    ]);
    // ira's only other task closed a month ago: it is off the list, so it does not count.
    expect(agents.map((v) => [v.view, v.label, v.count])).toEqual([
      ["agent:friday", "friday", 3],
      ["agent:ira", "ira", 1],
    ]);
  });

  test("every count is the number of tasks its view shows", () => {
    const { views, agents } = taskViews(tasks, NOW);
    for (const v of [...views, ...agents]) expect(ids(v.view)).toHaveLength(v.count);
  });

  test("Mine is what you filed and no chat has; Waiting is an agent's done? on a task still open", () => {
    expect(ids("mine").sort()).toEqual(["a", "e"]);
    expect(ids("waiting")).toEqual(["c"]); // f's word was answered: it is closed
    expect(isWaiting(tasks[2])).toBe(true);
    expect(isMine(tasks[1])).toBe(false); // filed by you, but assigned
  });

  test("an agent view whose agent has no tasks any more says so and stands (no quiet switch to All); while the tasks load it stands", () => {
    expect(resolveTaskView("agent:friday", tasks, NOW)).toEqual({ view: "agent:friday", missing: null });
    expect(resolveTaskView("agent:nobody", tasks, NOW)).toEqual({ view: "agent:nobody", missing: "nobody" });
    expect(resolveTaskView("agent:nobody", [], NOW)).toEqual({ view: "agent:nobody", missing: "nobody" });
    expect(resolveTaskView("waiting", tasks, NOW)).toEqual({ view: "waiting", missing: null });
    expect(resolveTaskView("agent:nobody", null, NOW)).toEqual({ view: "agent:nobody", missing: null });
  });

  test("a missing agent's note names it and asks for a pick", () => {
    expect(missingAgentLine("nobody")).toBe("nobody isn't here any more — pick an agent");
  });

  test("a stored view reads back; the Board's old status views and anything else are All", () => {
    expect(parseTaskView("mine")).toBe("mine");
    expect(parseTaskView("waiting")).toBe("waiting");
    expect(parseTaskView("agent:friday")).toBe("agent:friday");
    expect(parseTaskView("blocked")).toBe("all");
    expect(parseTaskView("agent:")).toBe("all");
    expect(parseTaskView(null)).toBe("all");
  });
});

describe("tasks: the Board's grouping and the Table's sort", () => {
  const tasks = [
    t({ id: "a", title: "beta", assignee: "ira", metadata: { by: "you", folder: "/w/infra", desk: "d1" }, updatedAt: "2026-09-06T09:00:00Z" }),
    t({
      id: "b",
      title: "Alpha",
      status: "in_progress",
      assignee: "friday",
      metadata: { by: "agent", agent: "friday", folder: "/w/site/" },
      updatedAt: "2026-09-06T11:00:00Z",
    }),
    t({ id: "c", title: "gamma", priority: 0, metadata: { by: "you" }, updatedAt: "2026-09-06T10:00:00Z" }),
    t({ id: "d", title: "delta", status: "closed", closedAt: "2026-09-06T11:30:00Z", assignee: "ira", metadata: { folder: "/w/infra" } }),
  ];
  const cols = (g: Parameters<typeof boardColumns>[1]) => boardColumns(tasks, g, NOW).map((c) => [c.label, c.tasks.map((x) => x.id)]);

  test("by status: always the four columns, empty ones too", () => {
    expect(cols("status")).toEqual([
      ["Open", ["c", "a"]],
      ["In progress", ["b"]],
      ["Blocked", []],
      ["Done · 7d", ["d"]],
    ]);
  });

  test("by assignee or folder: the ones with none first, then by name; done ones last in their column", () => {
    expect(cols("assignee")).toEqual([
      ["Unassigned", ["c"]],
      ["friday", ["b"]],
      ["ira", ["a", "d"]],
    ]);
    expect(cols("folder")).toEqual([
      ["No folder", ["c"]],
      ["infra", ["a", "d"]],
      ["site", ["b"]],
    ]);
  });

  test("the Table sorts by any column, either way; empty cells last; status puts done? first", () => {
    const rows = (sort: Sort) => tableRows(tasks, sort, (d) => (d === "d1" ? "Plans" : d), NOW).map((x) => x.id);
    expect(rows({ key: "title", dir: "asc" })).toEqual(["b", "a", "d", "c"]);
    expect(rows({ key: "title", dir: "desc" })).toEqual(["c", "d", "a", "b"]);
    expect(rows({ key: "updated", dir: "desc" })).toEqual(["d", "b", "c", "a"]);
    expect(rows({ key: "assignee", dir: "asc" })).toEqual(["b", "a", "d", "c"]);
    expect(rows({ key: "chat", dir: "desc" })).toEqual(["a", "c", "b", "d"]);
    const waiting = [...tasks, t({ id: "w", status: "in_progress", metadata: { doneAsked: "yes" } })];
    expect(tableRows(waiting, { key: "status", dir: "asc" }, undefined, NOW)[0].id).toBe("w");
  });

  test("a header's click flips its own direction; a new column starts ascending, a time newest first", () => {
    expect(nextSort({ key: "title", dir: "asc" }, "title")).toEqual({ key: "title", dir: "desc" });
    expect(nextSort({ key: "title", dir: "desc" }, "folder")).toEqual({ key: "folder", dir: "asc" });
    expect(nextSort({ key: "title", dir: "asc" }, "updated")).toEqual({ key: "updated", dir: "desc" });
  });

  test("a view's settings read back; anything missing or unknown is the default", () => {
    expect(parsePrefs(undefined)).toEqual(DEFAULT_PREFS);
    expect(parsePrefs({ layout: "table", groupBy: "folder", sort: { key: "title", dir: "asc" } })).toEqual({
      layout: "table",
      groupBy: "folder",
      sort: { key: "title", dir: "asc" },
    });
    expect(parsePrefs({ layout: "calendar", groupBy: "mood", sort: { key: "nope" } })).toEqual(DEFAULT_PREFS);
  });

  test("a cell reads as the Table shows it", () => {
    expect(cellText(tasks[0], "by", (d) => d)).toBe("you");
    expect(cellText(tasks[1], "by", (d) => d)).toBe("friday");
    expect(cellText(tasks[0], "chat", () => "Plans")).toBe("Plans");
    expect(cellText(tasks[1], "folder", (d) => d)).toBe("site");
    expect(folderName(undefined)).toBeNull();
  });
});

describe("tasks: cursor keys over any view", () => {
  const tasks = [
    t({ id: "a" }),
    t({ id: "b" }),
    t({ id: "c", status: "in_progress" }),
    t({ id: "d", status: "blocked", assignee: "ira" }),
    t({ id: "e", status: "blocked" }),
  ];

  test("the Board: up and down within a column, sideways to the nearest non-empty column", () => {
    const cols = boardColumns(viewTasks(tasks, "all", NOW), "status", NOW);
    expect(stepCursor(cols, null, "down")).toBe("a");
    expect(stepCursor(cols, "a", "down")).toBe("b");
    expect(stepCursor(cols, "b", "down")).toBeNull();
    expect(stepCursor(cols, "a", "up")).toBeNull();
    expect(stepCursor(cols, "b", "right")).toBe("c");
    expect(stepCursor(cols, "c", "right")).toBe("d");
    expect(stepCursor(cols, "d", "right")).toBeNull(); // done is empty and last
    expect(stepCursor(cols, "e", "left")).toBe("c");
  });

  test("the Table is one list: the same up and down, and sideways (the column step) has nowhere to go", () => {
    const blocked = tasks.filter((x) => x.status === "blocked");
    const cols = [{ id: "table", label: "Tasks", tasks: tableRows(blocked, { key: "title", dir: "asc" }, undefined, NOW) }];
    expect(stepCursor(cols, null, "down")).toBe("d");
    expect(stepCursor(cols, "d", "down")).toBe("e");
    expect(stepCursor(cols, "e", "up")).toBe("d");
    expect(stepCursor(cols, "d", "left")).toBeNull();
    expect(stepCursor(cols, "d", "right")).toBeNull();
    // A cursor left over from another view is not in this one: nowhere to step from.
    expect(stepCursor(cols, "a", "down")).toBeNull();
  });
});
