import { describe, expect, test } from "vitest";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { must } from "./fixtures/must.ts";
import {
  INIT_ARGS,
  TaskStore,
  taskIds,
  bdBinary,
  assignArgs,
  askDoneArgs,
  closeArgs,
  createArgs,
  formatTasksContext,
  TASKS_CLEARED,
  TasksNotice,
  parseTasks,
  projectLabel,
  clampPriority,
  tasksDir,
} from "../mod/tasks.ts";
import type { Task } from "../core/frame-types.ts";

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
  test("empty output is an empty task list", () => {
    expect(parseTasks("")).toEqual([]);
  });
});

describe("tasks: bd arguments", () => {
  test("create stamps the source and adds the project label", () => {
    const args = createArgs({
      title: "  write the quiz plan ",
      description: "outline first",
      labels: ["almonds", "plan"],
      priority: 1,
      stamp: { by: "agent", agent: "ira", agentId: "a1", conversation: "c9", desk: "c9", folder: "/Users/x/Documents/personal/Almonds" },
    });
    expect(args[0]).toBe("create");
    expect(args.slice(-2)).toEqual(["--", "write the quiz plan"]); // last, after --: never read as an option
    expect(args).toContain("--json");
    const md = JSON.parse(args[args.indexOf("--metadata") + 1]) as unknown;
    expect(md).toEqual({ by: "agent", agent: "ira", agentId: "a1", conversation: "c9", desk: "c9", folder: "/Users/x/Documents/personal/Almonds" });
    expect(args[args.indexOf("-l") + 1]).toBe("almonds,plan"); // folder label deduped against the agent's
    expect(args[args.indexOf("-p") + 1]).toBe("1");
  });
  test("only bd's own ids reach bd: one starting with - would be read as an option", () => {
    expect(taskIds(["lk-a1", "lk-a1.2", "--help", "-x", "", "a b"])).toEqual(["lk-a1", "lk-a1.2"]);
  });
  test("a task from the app carries by=you and no agent", () => {
    const md = JSON.parse(
      must(
        createArgs({ title: "x", stamp: { by: "you", desk: "shared" } }).find((_, i, a) => a[i - 1] === "--metadata"),
        "the metadata argument",
      ),
    ) as unknown;
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
  const t = (over: Partial<Task>): Task => ({
    id: "lk-a1",
    title: "rotate SSO creds",
    description: "",
    status: "open",
    priority: 1,
    labels: [],
    assignee: null,
    createdAt: "",
    updatedAt: "",
    closedAt: null,
    metadata: {},
    ...over,
  });
  test("only tasks assigned to this conversation, never closed ones", () => {
    const block = formatTasksContext(
      [
        t({ metadata: { assignedTo: "c1", by: "agent", agent: "friday" } }),
        t({ id: "lk-b2", metadata: { assignedTo: "c2" } }),
        t({ id: "lk-c3", status: "closed", metadata: { assignedTo: "c1" } }),
      ],
      { conversation: "c1" },
    );
    expect(block).toContain("<loki-tasks>");
    expect(block).toContain("lk-a1  P1  rotate SSO creds — filed by friday");
    expect(block).not.toContain("lk-b2");
    expect(block).not.toContain("lk-c3");
    expect(block).toContain("tasks");
  });
  test("nothing assigned: no block at all", () => {
    expect(formatTasksContext([t({})], { conversation: "c1" })).toBeNull();
  });
});

describe("tasks: told once, again only on a change", () => {
  const t = (over: Partial<Task>): Task => ({
    id: "lk-a1",
    title: "rotate SSO creds",
    description: "",
    status: "open",
    priority: 1,
    labels: [],
    assignee: null,
    createdAt: "",
    updatedAt: "",
    closedAt: null,
    metadata: { assignedTo: "c1" },
    ...over,
  });
  const deliver = (n: TasksNotice, conv: string, tasks: Task[]) => {
    const block = n.pending(conv, tasks);
    if (block) n.sent(conv, block);
    return block;
  };
  test("the same list rides along once; a new, closed or started task sends it again", () => {
    const n = new TasksNotice();
    const one = [t({})];
    expect(deliver(n, "c1", one)).toContain("lk-a1");
    expect(deliver(n, "c1", one)).toBeNull();
    expect(deliver(n, "c1", [...one, t({ id: "lk-b2" })])).toContain("lk-b2");
    expect(deliver(n, "c1", [t({ status: "in_progress" }), t({ id: "lk-b2" })])).toContain("in progress");
    expect(deliver(n, "c2", one)).toBeNull(); // nothing assigned to c2
  });
  test("the last task leaving says so once, then nothing", () => {
    const n = new TasksNotice();
    deliver(n, "c1", [t({})]);
    expect(deliver(n, "c1", [t({ status: "closed" })])).toBe(TASKS_CLEARED);
    expect(deliver(n, "c1", [])).toBeNull();
  });
  test("a block not attached is still pending; after compaction it is sent again", () => {
    const n = new TasksNotice();
    const one = [t({})];
    expect(n.pending("c1", one)).toContain("lk-a1"); // approvals-only turn: never marked sent
    expect(deliver(n, "c1", one)).toContain("lk-a1");
    n.forget("c1");
    expect(deliver(n, "c1", one)).toContain("lk-a1");
  });
});

describe("tasks: the store", () => {
  test("calls run serially and keeps a cache for synchronous readers", async () => {
    const calls: string[][] = [];
    let inFlight = 0;
    let maxInFlight = 0;
    const store = new TaskStore({
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
    const [list, created] = await Promise.all([store.list(), store.create({ title: "new one", stamp: { by: "you" } })]);
    expect(maxInFlight).toBe(1);
    expect(list).toHaveLength(2);
    expect(created.id).toBe("lk-new");
    expect(store.cached().map((x) => x.id)).toEqual(["lk-a1", "lk-b2", "lk-new"]);
    await store.close(["lk-a1"], "done");
    expect(store.cached().map((x) => x.id)).toEqual(["lk-b2", "lk-new"]);
    expect(calls.map((c) => c[0])).toEqual(["list", "create", "close"]);
  });
  test("a title is required", async () => {
    await expect(new TaskStore({ dir: "/nonexistent", run: () => Promise.resolve("[]") }).create({ title: "  ", stamp: { by: "you" } })).rejects.toThrow(
      /title/,
    );
  });
});

describe("task store setup", () => {
  test("init is non-interactive with the lk prefix", () => {
    expect(INIT_ARGS).toEqual(["init", "--prefix", "lk", "--non-interactive"]);
  });
  test("bdBinary honours LOKI_BD and searches PATH", () => {
    const prev = { bd: process.env.LOKI_BD, path: process.env.PATH };
    process.env.LOKI_BD = process.execPath; // any existing file
    expect(bdBinary()).toBe(process.execPath);
    delete process.env.LOKI_BD;
    process.env.PATH = "/definitely/not/here";
    const found = bdBinary();
    expect(found === null || /[\\/]bd(\.exe)?$/i.test(found)).toBe(true);
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

describe("tasks: the folder, from when Tasks was the Board", () => {
  test("a list in <loki>/board moves to <loki>/tasks once, and is found there after", () => {
    const home = mkdtempSync(join(tmpdir(), "loki-tasks-dir-"));
    try {
      mkdirSync(join(home, "board", ".beads"), { recursive: true });
      writeFileSync(join(home, "board", ".beads", "marker"), "kept");
      expect(tasksDir(home, {})).toBe(join(home, "tasks"));
      expect(existsSync(join(home, "board"))).toBe(false);
      expect(readFileSync(join(home, "tasks", ".beads", "marker"), "utf8")).toBe("kept");
      expect(tasksDir(home, {})).toBe(join(home, "tasks"));
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("a new install gets <loki>/tasks; an existing tasks folder wins over a stray board one; the env var wins over both", () => {
    const home = mkdtempSync(join(tmpdir(), "loki-tasks-dir-"));
    try {
      expect(tasksDir(home, {})).toBe(join(home, "tasks"));
      mkdirSync(join(home, "tasks"));
      mkdirSync(join(home, "board"));
      expect(tasksDir(home, {})).toBe(join(home, "tasks"));
      expect(existsSync(join(home, "board"))).toBe(true); // left alone
      expect(tasksDir(home, { LOKI_TASKS_DIR: "/x/t" })).toBe("/x/t");
      expect(tasksDir(home, { LOKI_BOARD_DIR: "/x/b" })).toBe("/x/b");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test.skipIf(process.platform === "win32")("a board folder that cannot move is used where it is", () => {
    // A read-only <loki> folder: the rename inside it fails.
    const home = mkdtempSync(join(tmpdir(), "loki-tasks-dir-"));
    mkdirSync(join(home, "board"));
    chmodSync(home, 0o500);
    try {
      expect(tasksDir(home, {})).toBe(join(home, "board"));
    } finally {
      chmodSync(home, 0o700);
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("tasks: an agent's done?, and reopening", () => {
  test("a close goes as the assignee (an agent's own task) or forced (yours, from Tasks): beads refuses anyone else", () => {
    expect(closeArgs(["lk-a1"], "spec written", { actor: "friday" })).toEqual(["close", "lk-a1", "--actor", "friday", "--json", "--reason", "spec written"]);
    expect(closeArgs(["lk-a1", "lk-b2"], undefined, { force: true })).toEqual(["close", "lk-a1", "lk-b2", "--force", "--json"]);
    expect(closeArgs(["lk-a1"])).toEqual(["close", "lk-a1", "--json"]);
  });

  test("done? sets the agent's reason, who and when; no reason reads yes", () => {
    const now = new Date("2026-10-13T10:00:00Z");
    expect(askDoneArgs("lk-a1", { reason: "migrated staging", by: "friday" }, now)).toEqual([
      "update",
      "lk-a1",
      "--set-metadata",
      "doneAsked=migrated staging",
      "--set-metadata",
      "doneAskedAt=2026-10-13T10:00:00.000Z",
      "--set-metadata",
      "doneAskedBy=friday",
      "--json",
    ]);
    expect(askDoneArgs("lk-a1", {}, now)).toContain("doneAsked=yes");
  });

  test("reopen clears an agent's done? and reopens only what is closed", async () => {
    const calls: string[][] = [];
    const store = new TaskStore({
      dir: "/tmp/nowhere",
      run: (args) => {
        calls.push(args);
        if (args[0] === "update") return Promise.resolve(JSON.stringify([raw({ id: "lk-a1", status: "in_progress" }), raw({ id: "lk-b2", status: "closed" })]));
        if (args[0] === "reopen") return Promise.resolve(JSON.stringify([raw({ id: "lk-b2", status: "open" })]));
        return Promise.resolve("[]");
      },
    });
    const tasks = await store.reopen(["lk-a1", "lk-b2"]);
    expect(calls).toEqual([
      ["update", "lk-a1", "lk-b2", "--unset-metadata", "doneAsked", "--unset-metadata", "doneAskedBy", "--unset-metadata", "doneAskedAt", "--json"],
      ["reopen", "lk-b2", "--json"],
    ]);
    expect(tasks.map((t) => [t.id, t.status])).toEqual([
      ["lk-a1", "in_progress"],
      ["lk-b2", "open"],
    ]);
  });
});
