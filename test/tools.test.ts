import { describe, expect, test } from "vitest";
import { registerTools, type ToolDeps } from "../mod/tools.ts";
import { DeskStore } from "../mod/desk-store.ts";
import { GestureLog } from "../mod/gestures.ts";
import type { ModApi, ModTool } from "../daemon/mods/api.ts";
import type { WidgetManifestEntry } from "../core/desk-core.ts";
import { must } from "./fixtures/must.ts";

const sleep: WidgetManifestEntry = {
  id: "c1/sleep",
  scope: "c1",
  name: "sleep",
  kind: "json",
  file: "c1/sleep.json",
  title: "Sleep",
  type: "slider-control",
  data: { value: 6 },
  hash: "h",
  updated_at: 0,
  error: 'missing "title"',
};
const welcome: WidgetManifestEntry = {
  ...sleep,
  id: "shared/welcome",
  scope: "shared",
  name: "welcome",
  file: "shared/welcome.json",
  title: "loki",
  type: "info-card",
  data: { lines: ["a"] },
  error: undefined,
};

/** Each tool as the test calls it: a call's args and, when it has one, its chat and agent. A failed call throws. */
interface Called {
  name: string;
  description: string;
  run: (c: { args?: Record<string, unknown>; conversation?: { id: string }; agent?: { id: string; name: string } }) => Promise<unknown>;
}

function harness(deps?: Partial<ToolDeps>) {
  const tools = new Map<string, Called>();
  const api = {
    tools: {
      register: (t: ModTool) => {
        tools.set(t.name, {
          name: t.name,
          description: t.description,
          run: async (c) =>
            await t.execute(c.args ?? {}, {
              chatId: c.conversation?.id ?? "",
              agentId: c.agent?.id ?? "",
              agentName: c.agent?.name ?? "",
              signal: new AbortController().signal,
              output: () => {},
            }),
        });
        return () => tools.delete(t.name);
      },
    },
  } as unknown as ModApi;
  const store = new DeskStore();
  store.gesture("c1", { kind: "set", id: "c1/sleep", path: "value", value: 7 });
  const gestures = new GestureLog();
  gestures.record("c1", "moved something");
  const broadcasts: Array<[unknown, string | undefined]> = [];
  const entries = [sleep, welcome];
  registerTools(api, {
    store,
    gestures,
    widgets: {
      entries: (s) => entries.filter((e) => !s || e.scope === s),
      get: (id) => entries.find((e) => e.id === id),
      setRuntimeError: () => false,
      rescan: () => Promise.resolve(),
      close: () => {},
    },
    widgetsDir: "/proj/app/src/widgets",
    activeScope: () => "c1",
    broadcast: (m, s) => broadcasts.push([m, s]),
    ...deps,
  });
  return { tools, broadcasts };
}

/** What canvas_read answers, as the tests read it. */
interface DeskState {
  desk: string;
  widgets_dir: string;
  widgets: Array<{ id: string }>;
  shared?: Array<{ error?: unknown }>;
  pending_canvas_activity: unknown;
}
const deskState = async (tools: Map<string, Called>, c: Parameters<Called["run"]>[0]) =>
  JSON.parse((await must(tools.get("canvas_read"), "canvas_read").run(c)) as string) as DeskState;

describe("the mod's tools", () => {
  test("canvas_read and canvas_focus always, the task tools once Tasks is ready; every name <subject>_<verb> (plan 044)", () => {
    expect([...harness().tools.keys()].sort()).toEqual(["canvas_focus", "canvas_read"]);
    const names = [...harness({ tasks: {} as ToolDeps["tasks"] }).tools.keys()].sort();
    expect(names).toEqual(["canvas_focus", "canvas_read", "task_close", "task_comment", "task_create", "task_list"]);
    expect(names.filter((n) => !/^[a-z][a-z0-9]*_[a-z0-9]+$/.test(n))).toEqual([]);
  });
});

describe("canvas_read", () => {
  test("returns own desk + shared, merged data, layout, errors, pending activity", async () => {
    const { tools } = harness();
    const out = await deskState(tools, { args: {} });
    expect(out.desk).toBe("c1");
    expect(out.widgets_dir).toBe("/proj/app/src/widgets/c1");
    expect(out.widgets[0]).toMatchObject({ id: "c1/sleep", file: "/proj/app/src/widgets/c1/sleep.json", data: { value: 7 }, error: 'missing "title"' });
    expect(must(out.shared, "the shared desk")[0]).toMatchObject({ id: "shared/welcome", data: { lines: ["a"] } });
    expect(must(out.shared, "the shared desk")[0].error).toBeUndefined();
    expect(out.pending_canvas_activity).toEqual(["moved something"]);
  });
  test("the desk comes from the calling conversation, not the mod's active desk", async () => {
    const remembered: string[] = [];
    const { tools } = harness({ remember: (id) => (remembered.push(id), id.replace(/[^a-zA-Z0-9_-]/g, "_")) });
    const out = await deskState(tools, { args: {}, conversation: { id: "local-conv-1291" } });
    expect(out.desk).toBe("local-conv-1291"); // not "c1", the active desk in this harness
    expect(remembered).toEqual(["local-conv-1291"]);
    const explicit = await deskState(tools, { args: { desk: "shared" }, conversation: { id: "local-conv-1291" } });
    expect(explicit.desk).toBe("shared");
  });

  test("explicit desk=shared returns only the shared desk", async () => {
    const { tools } = harness();
    const out = await deskState(tools, { args: { desk: "shared" } });
    expect(out.desk).toBe("shared");
    expect(out.shared).toBeUndefined();
    expect(out.widgets.map((w: { id: string }) => w.id)).toEqual(["shared/welcome"]);
  });
  test("description tells the agent to write files, not to look for a render tool", () => {
    const { tools } = harness();
    expect(must(tools.get("canvas_read"), "canvas_read").description).toMatch(/write a file/);
    expect(must(tools.get("canvas_read"), "canvas_read").description).toMatch(/@loki\/kit/);
  });
});

describe("canvas_focus", () => {
  test("broadcasts to the widget's desk; shared goes to everyone; missing errors", async () => {
    const { tools, broadcasts } = harness();
    const cam = must(tools.get("canvas_focus"), "canvas_focus");
    expect(await cam.run({ args: { widget_id: "c1/sleep" } })).toMatch(/gliding/);
    expect(broadcasts[0]).toEqual([{ type: "camera", widget_id: "c1/sleep", widget_ids: ["c1/sleep"] }, "c1"]);
    await cam.run({ args: { widget_id: "shared/welcome" } });
    expect(broadcasts[1][1]).toBeUndefined();
    // A bad call fails, with what to do about it.
    await expect(cam.run({ args: { widget_id: "nope" } })).rejects.toThrow('no widget "nope" — check canvas_read');
    await expect(cam.run({ args: {} })).rejects.toThrow("give widget_id or widget_ids");
  });

  test("frames several widgets and honours dwell", async () => {
    const { tools, broadcasts } = harness();
    const cam = must(tools.get("canvas_focus"), "canvas_focus");
    const t = Date.now();
    const out = await cam.run({ args: { widget_ids: ["c1/sleep", "shared/welcome"], dwell: 120 } });
    expect(Date.now() - t).toBeGreaterThanOrEqual(110);
    expect(out).toMatch(/framing 2 widgets, held 120ms/);
    expect(broadcasts[0]).toEqual([{ type: "camera", widget_id: "c1/sleep", widget_ids: ["c1/sleep", "shared/welcome"] }, undefined]);
  });
});

describe("the task tools: a chat's own tasks, and only you close yours", () => {
  const task = (id: string, metadata: Record<string, string>, status = "open") => ({
    id,
    title: id,
    description: "",
    status,
    priority: 2,
    labels: [],
    assignee: null,
    created_at: "",
    updated_at: "",
    closed_at: null,
    metadata,
  });
  function withTasks() {
    const tasks = [
      task("lk-mine", { by: "you", assigned_to: "c1" }),
      { ...task("lk-agent", { by: "agent", agent: "friday", conversation: "c1" }), assignee: "friday-old-name" },
      task("lk-other", { by: "you", assigned_to: "c2" }),
      task("lk-loose", { by: "you" }),
      task("lk-done", { by: "agent", assigned_to: "c1" }, "closed"),
    ];
    const calls: string[] = [];
    const store = {
      find: (id: string) => Promise.resolve(tasks.find((t) => t.id === id) ?? null),
      list: () => Promise.resolve(tasks.filter((t) => t.status !== "closed")),
      comment: (id: string) => {
        calls.push(`comment ${id}`);
        return Promise.resolve();
      },
      close: (ids: string[], reason?: string, as?: { actor?: string | null }) => (
        calls.push(`close ${ids.join(",")} ${reason ?? ""}${as?.actor ? ` as ${as.actor}` : ""}`),
        Promise.resolve([])
      ),
      askDone: (id: string, ask: { reason?: string | null; by?: string | null }) => (
        calls.push(`askDone ${id} ${ask.reason} by ${ask.by}`),
        Promise.resolve([])
      ),
    };
    const h = harness({ tasks: store as unknown as ToolDeps["tasks"] });
    const run = (tool: string, args: Record<string, unknown>, conversation = "c1") =>
      must(h.tools.get(tool), tool).run({ args, conversation: { id: conversation }, agent: { id: "agent-f", name: "friday" } });
    return { run, calls, broadcasts: h.broadcasts };
  }

  test("closing a task the user filed marks it done? for the user to confirm; it stays open", async () => {
    const { run, calls, broadcasts } = withTasks();
    const out = String(await run("task_close", { id: "lk-mine", reason: "migrated staging and prod" }));
    expect(out).toContain("waits for the user to confirm");
    expect(calls).toEqual(["askDone lk-mine migrated staging and prod by friday"]);
    expect(broadcasts.map(([m]) => m)).toContainEqual({ type: "tasks_changed" });
  });

  test("a task an agent filed from this chat closes outright, as its assignee (beads refuses anyone else)", async () => {
    const { run, calls } = withTasks();
    expect(String(await run("task_close", { id: "lk-agent", reason: "done" }))).toBe("lk-agent closed");
    expect(calls).toEqual(["close lk-agent done as friday-old-name"]);
  });

  test("another chat's task, or one this chat never had, is refused for close and comment", async () => {
    const { run, calls } = withTasks();
    await expect(run("task_close", { id: "lk-other" })).rejects.toThrow(/assigned to another chat/);
    await expect(run("task_comment", { id: "lk-other", text: "hi" })).rejects.toThrow(/not this conversation's task/);
    await expect(run("task_close", { id: "lk-loose" })).rejects.toThrow(/not this conversation's task/);
    await expect(run("task_close", { id: "lk-nope" })).rejects.toThrow(/no task lk-nope/);
    expect(calls).toEqual([]);
  });

  test("a comment on this chat's task goes through (and tells the app, for the message's chip); a closed one is not closed twice", async () => {
    const { run, calls, broadcasts } = withTasks();
    expect(String(await run("task_comment", { id: "lk-mine", text: "staging done" }))).toBe("noted on lk-mine");
    expect(broadcasts.map(([m]) => m)).toContainEqual({ type: "tasks_changed" });
    expect(String(await run("task_close", { id: "lk-done" }))).toBe("lk-done is already closed");
    expect(calls).toEqual(["comment lk-mine"]);
  });

  test("list shows this chat's tasks; the description tells the agent the rule", async () => {
    const { run } = withTasks();
    const listed = JSON.parse(String(await run("task_list", {}))) as Array<{ id: string }>;
    expect(listed.map((t) => t.id)).toEqual(["lk-mine", "lk-agent"]);
    const h = harness({ tasks: {} as ToolDeps["tasks"] });
    expect(must(h.tools.get("task_close"), "task_close").description).toMatch(/Only the user closes a task the user filed/);
  });
});
