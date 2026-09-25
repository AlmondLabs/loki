import { describe, expect, test } from "bun:test";
import { INIT_ARGS, TaskBoard, bdBinary, assignArgs, createArgs, formatTasksContext, parseTasks, projectLabel, clampPriority, type Task } from "../mod/tasks.ts";

const raw = (over: Record<string, unknown> = {}) => ({
  id: "lk-a1",
  title: "rotate SSO creds",
  description: "before the audit",
  status: "open",
  priority: 1,
  labels: ["aws"],
  created_at: "2026-09-06T10:00:00Z",
  updated_at: "2026-09-06T10:00:00Z",
  metadata: { by: "agent", agent: "friday", conversation: "c1", desk: "c1", folder: "/Users/x/infra" },
  ...over,
});

describe("tasks: parsing", () => {
  test("list output (array) and create output (object) both parse", () => {
    expect(parseTasks(JSON.stringify([raw(), raw({ id: "lk-b2" })])).map((t) => t.id)).toEqual(["lk-a1", "lk-b2"]);
    const [one] = parseTasks(JSON.stringify(raw()));
    expect(one.assignee).toBeNull();
    expect(one.metadata.agent).toBe("friday");
    expect(one.closedAt).toBeNull();
  });
  test("a warning line before the JSON is skipped", () => {
    expect(parseTasks("warning: beads.role not configured\n" + JSON.stringify([raw()]))).toHaveLength(1);
  });
  test("empty output is an empty board", () => {
    expect(parseTasks("")).toEqual([]);
  });
});

describe("tasks: bd arguments", () => {
  test("create stamps the source and adds the project label", () => {
    const args = createArgs({ title: "  write the quiz plan ", description: "outline first", labels: ["almonds", "plan"], priority: 1, stamp: { by: "agent", agent: "ira", agentId: "a1", conversation: "c9", desk: "c9", folder: "/Users/x/Documents/personal/Almonds" } });
    expect(args.slice(0, 2)).toEqual(["create", "write the quiz plan"]);
    expect(args).toContain("--json");
    const md = JSON.parse(args[args.indexOf("--metadata") + 1]);
    expect(md).toEqual({ by: "agent", agent: "ira", agentId: "a1", conversation: "c9", desk: "c9", folder: "/Users/x/Documents/personal/Almonds" });
    expect(args[args.indexOf("-l") + 1]).toBe("almonds,plan"); // folder label deduped against the agent's
    expect(args[args.indexOf("-p") + 1]).toBe("1");
  });
  test("a task from the app carries by=you and no agent", () => {
    const md = JSON.parse(createArgs({ title: "x", stamp: { by: "you", desk: "shared" } }).find((_, i, a) => a[i - 1] === "--metadata")!);
    expect(md).toEqual({ by: "you", desk: "shared" });
  });
  test("assign sets assignee and the target in metadata; dispatch also starts it", () => {
    const a = assignArgs(["lk-a1", "lk-b2"], { agent: "friday", agentId: "ag", conversation: "c2", desk: "c2" });
    expect(a.slice(0, 3)).toEqual(["update", "lk-a1", "lk-b2"]);
    expect(a).toContain("assignedTo=c2");
    expect(a[a.indexOf("--assignee") + 1]).toBe("friday");
    expect(a).not.toContain("--status");
    expect(assignArgs(["lk-a1"], { agent: null, agentId: null, conversation: "c2", desk: "c2" }, "in_progress")).toContain("in_progress");
  });
  test("priority clamps to 0–4, default 2", () => {
    expect(clampPriority(undefined)).toBe(2);
    expect(clampPriority(9)).toBe(4);
    expect(clampPriority(-1)).toBe(0);
  });
  test("project label is the folder's name, made safe", () => {
    expect(projectLabel("/Users/x/Documents/personal/loki")).toBe("loki");
    expect(projectLabel("/Users/x/My Project (v2)")).toBe("my-project-v2");
    expect(projectLabel(null)).toBeNull();
  });
});

describe("tasks: turn-start block", () => {
  const t = (over: Partial<Task>): Task => ({ id: "lk-a1", title: "rotate SSO creds", description: "", status: "open", priority: 1, labels: [], assignee: null, createdAt: "", updatedAt: "", closedAt: null, metadata: {}, ...over });
  test("only tasks assigned to this conversation, never closed ones", () => {
    const block = formatTasksContext(
      [t({ metadata: { assignedTo: "c1", by: "agent", agent: "friday" } }), t({ id: "lk-b2", metadata: { assignedTo: "c2" } }), t({ id: "lk-c3", status: "closed", metadata: { assignedTo: "c1" } })],
      { conversation: "c1" },
    );
    expect(block).toContain("<loki-tasks>");
    expect(block).toContain("lk-a1  P1  rotate SSO creds — filed by friday");
    expect(block).not.toContain("lk-b2");
    expect(block).not.toContain("lk-c3");
    expect(block).toContain("loki_task");
  });
  test("nothing assigned: no block at all", () => {
    expect(formatTasksContext([t({})], { conversation: "c1" })).toBeNull();
  });
});

describe("tasks: board", () => {
  test("calls run serially and keeps a cache for synchronous readers", async () => {
    const calls: string[][] = [];
    let inFlight = 0;
    let maxInFlight = 0;
    const board = new TaskBoard({
      dir: "/nonexistent",
      run: async (args) => {
        calls.push(args);
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((r) => setTimeout(r, 5));
        inFlight--;
        if (args[0] === "list") return JSON.stringify([raw(), raw({ id: "lk-b2", status: "in_progress" })]);
        if (args[0] === "create") return JSON.stringify(raw({ id: "lk-new", title: args[1] }));
        if (args[0] === "close") return JSON.stringify([raw({ status: "closed", closed_at: "2026-09-06T11:00:00Z" })]);
        return "[]";
      },
    });
    const [list, created] = await Promise.all([board.list(), board.create({ title: "new one", stamp: { by: "you" } })]);
    expect(maxInFlight).toBe(1);
    expect(list).toHaveLength(2);
    expect(created.id).toBe("lk-new");
    expect(board.cached().map((x) => x.id)).toEqual(["lk-a1", "lk-b2", "lk-new"]);
    await board.close(["lk-a1"], "done");
    expect(board.cached().map((x) => x.id)).toEqual(["lk-b2", "lk-new"]);
    expect(calls.map((c) => c[0])).toEqual(["list", "create", "close"]);
  });
  test("a title is required", async () => {
    await expect(new TaskBoard({ dir: "/nonexistent", run: async () => "[]" }).create({ title: "  ", stamp: { by: "you" } })).rejects.toThrow(/title/);
  });
});

describe("board setup", () => {
  test("init is non-interactive with the lk prefix", () => {
    expect(INIT_ARGS).toEqual(["init", "--prefix", "lk", "--non-interactive"]);
  });
  test("bdBinary honours LOKI_BD and searches PATH", () => {
    const prev = { bd: process.env.LOKI_BD, path: process.env.PATH };
    process.env.LOKI_BD = process.execPath; // any existing file
    expect(bdBinary()).toBe(process.execPath);
    delete process.env.LOKI_BD;
    process.env.PATH = "/definitely/not/here";
    expect(bdBinary() === null || /[\\/]bd(\.exe)?$/i.test(bdBinary()!)).toBe(true);
    if (prev.bd !== undefined) process.env.LOKI_BD = prev.bd;
    process.env.PATH = prev.path;
  });
  test("bdBinary finds bd.exe on a Windows PATH", () => {
    const env = { Path: String.raw`C:\Windows\system32;C:\Users\someone\go\bin`, PATHEXT: ".COM;.EXE;.BAT;.CMD" };
    const want = String.raw`C:\Users\someone\go\bin\bd.exe`;
    expect(bdBinary({ platform: "win32", env, exists: (p) => p === want })).toBe(want);
    expect(bdBinary({ platform: "win32", env, exists: () => false })).toBeNull();
    expect(bdBinary({ platform: "win32", env: { ...env, LOKI_BD: "D:\\bd.exe" }, exists: (p) => p === "D:\\bd.exe" || p === want })).toBe("D:\\bd.exe");
  });
});
