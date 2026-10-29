import { describe, expect, test } from "vitest";
import { registerTools, type ToolDeps } from "../mod/tools.ts";
import { DeskStore } from "../mod/desk-store.ts";
import { GestureLog } from "../mod/gestures.ts";
import type { ModApi, ModTool } from "../daemon/mods/api.ts";
import type { WidgetManifestEntry } from "../core/desk-core.ts";
import { must } from "./fixtures/must.ts";
import type { DeskSummary, Suggestion } from "../core/frame-types.ts";
import { Suggestions } from "../mod/suggestions.ts";
import { asks, kindOf } from "../daemon/approvals.ts";

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
  annotations: ModTool["annotations"];
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
          annotations: t.annotations,
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
  test("canvas_read and canvas_focus always, and no task_* tool: Tasks is retired into suggestions (plan 049, U6)", () => {
    const names = [...harness().tools.keys()].sort();
    expect(names).toEqual(["canvas_focus", "canvas_read"]);
    expect(names.filter((n) => n.startsWith("task_"))).toEqual([]);
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

/** Plan 049, U3: chat_list and the suggestion tools, on a Mac with one paired Mac. */
describe("chat_list and the suggestion tools", () => {
  const FRIDAY = "agent-local-friday";
  const IRA = "agent-local-ira";
  const NOVA = "agent-local-nova";
  const desk = (d: Partial<DeskSummary> & { conversation_id: string; agent_id: string }): DeskSummary => ({
    scope: d.conversation_id,
    title: null,
    status: "live",
    agent_name: d.agent_id === IRA ? "Ira" : "Friday",
    model: null,
    reasoning_effort: null,
    labels: [],
    purpose: null,
    cwd: null,
    pinned: false,
    widgets: 0,
    active: false,
    last_active: null,
    ...d,
  });
  const chats = [
    desk({ conversation_id: "conv-source", agent_id: FRIDAY, title: "suggestions plan", cwd: "/work/loki", last_active: "2026-10-29T09:00:00.000Z" }),
    desk({
      conversation_id: "conv-infra",
      agent_id: FRIDAY,
      title: "infra",
      cwd: "/work/infra",
      labels: ["ops"],
      pinned: true,
      purpose: "Everything about the build machines",
      last_active: "2026-10-28T10:00:00.000Z",
    }),
    desk({ conversation_id: "conv-site", agent_id: IRA, title: "site", cwd: "/work/site", home: "mac-laptop", home_name: "laptop", reachable: true }),
    desk({ conversation_id: "conv-old", agent_id: FRIDAY, title: "old notes", cwd: "/work/old", status: "archived" }),
  ];
  const agents = [
    { id: FRIDAY, name: "Friday", mac: "studio", reachable: true },
    { id: IRA, name: "Ira", mac: "laptop", reachable: true },
    { id: NOVA, name: "Nova", mac: "laptop", reachable: false },
  ];

  function suggesting() {
    const records = new Map<string, Suggestion[]>([
      [`${FRIDAY}/conv-source`, []],
      [`${FRIDAY}/conv-infra`, []],
    ]);
    let n = 0;
    const suggestions = new Suggestions({
      records: {
        read: (a, c) => Promise.resolve(records.has(`${a}/${c}`) ? { suggestions: records.get(`${a}/${c}`) ?? [], archived: false } : null),
        write: (a, c, s) => (records.set(`${a}/${c}`, s), Promise.resolve()),
      },
      chat: () => ({ title: "infra", status: "live", has_draft: false }),
      agentExists: () => true,
      call: () => Promise.resolve({ ok: true, reply: {} }),
      push: () => {},
      newId: () => `sugg-${++n}`,
      now: () => new Date("2026-10-29T10:00:00.000Z"),
    });
    const h = harness({
      chats: { suggestions, agents: () => Promise.resolve(agents), chats: () => chats, passChat: (id) => id.startsWith("reflection-") },
    });
    const run = (tool: string, args: Record<string, unknown>, conversation = "conv-source") =>
      must(h.tools.get(tool), tool).run({ args, conversation: { id: conversation }, agent: { id: FRIDAY, name: "Friday" } });
    return { run, records, suggestions, tools: h.tools };
  }

  test("the four tools come with the chat listing; every name is <subject>_<verb>", () => {
    const names = [...suggesting().tools.keys()].sort();
    expect(names).toEqual(["canvas_focus", "canvas_read", "chat_list", "suggestion_create", "suggestion_list", "suggestion_withdraw"]);
    expect(names.filter((n) => !/^[a-z][a-z0-9]*_[a-z0-9]+$/.test(n))).toEqual([]);
  });

  test("chat_list lists this Mac's and the paired Mac's open chats, one line each, leaves out archived ones and marks the calling chat", async () => {
    const out = String(await suggesting().run("chat_list", {}));
    const lines = out.split("\n");
    const infra = must(
      lines.find((l) => l.includes("conv-infra")),
      "the infra row",
    );
    for (const part of [FRIDAY, "Friday", '"infra"', "/work/infra", "ops", "pinned", "2026-10-28T10:00:00.000Z", "Everything about the build machines"])
      expect(infra).toContain(part);
    expect(
      must(
        lines.find((l) => l.includes("conv-site")),
        "the paired Mac's row",
      ),
    ).toContain("laptop");
    expect(
      must(
        lines.find((l) => l.includes("conv-source")),
        "the calling chat",
      ),
    ).toContain("this chat");
    expect(infra).not.toContain("this chat");
    expect(out).not.toContain("conv-old");
  });

  test("chat_list lists an agent with no chats, with its Mac and whether it is in reach; a filter narrows the lines", async () => {
    const { run } = suggesting();
    const nova = must(
      String(await run("chat_list", {}))
        .split("\n")
        .find((l) => l.includes(NOVA)),
      "Nova's row",
    );
    expect(nova).toContain("Nova");
    expect(nova).toContain("laptop");
    expect(nova).toContain("out of reach");
    const filtered = String(await run("chat_list", { filter: "BUILD MACHINES" }));
    expect(filtered).toContain("conv-infra");
    expect(filtered).not.toContain("conv-site");
  });

  test("suggestion_create for an existing chat stores a pending suggestion on the calling chat and returns its id", async () => {
    const { run, records } = suggesting();
    const out = String(
      await run("suggestion_create", {
        title: "Fix the runner's disk",
        text: "The runner at /work/infra/runner.sh fills the disk.",
        target: { agent_id: FRIDAY, conversation_id: "conv-infra" },
      }),
    );
    expect(out).toContain("sugg-1");
    expect(records.get(`${FRIDAY}/conv-source`)).toMatchObject([
      { id: "sugg-1", title: "Fix the runner's disk", status: "pending", target: { agent_id: FRIDAY, conversation_id: "conv-infra" } },
    ]);
    // A new chat: a listed agent, in a folder one of the chats works in.
    await run("suggestion_create", { title: "Redo the site", text: "Rebuild /work/site.", target: { agent_id: IRA, folder: "/work/site" } });
    expect(records.get(`${FRIDAY}/conv-source`)?.[1]).toMatchObject({ target: { agent_id: IRA, folder: "/work/site" } });
  });

  test("suggestion_create for an unknown agent, chat or folder errors with the valid choices and stores nothing", async () => {
    const { run, records } = suggesting();
    const make = (target: unknown) => run("suggestion_create", { title: "t", text: "x", target });
    await expect(make({ agent_id: "agent-local-ghost", folder: "/work/loki" })).rejects.toThrow(new RegExp(`${FRIDAY}.*${IRA}.*${NOVA}`));
    await expect(make({ agent_id: FRIDAY, conversation_id: "conv-old" })).rejects.toThrow(/conv-infra/);
    await expect(make({ agent_id: FRIDAY, conversation_id: "conv-site" })).rejects.toThrow(new RegExp(IRA));
    await expect(make({ agent_id: FRIDAY, folder: "/nowhere" })).rejects.toThrow(/\/work\/infra/);
    await expect(make(undefined)).rejects.toThrow(/target/);
    expect(records.get(`${FRIDAY}/conv-source`)).toEqual([]);
  });

  test("suggestion_list shows a suggestion the person pointed at another chat with its final target", async () => {
    const { run, suggestions } = suggesting();
    await run("suggestion_create", { title: "Fix the runner", text: "x", target: { agent_id: FRIDAY, conversation_id: "conv-infra" } });
    await suggestions.retarget({ agent_id: FRIDAY, conversation_id: "conv-source" }, "sugg-1", { agent_id: IRA, conversation_id: "conv-site" });
    const out = String(await run("suggestion_list", {}));
    expect(out).toContain("sugg-1");
    expect(out).toContain("pending");
    expect(out).toContain("conv-site");
    expect(out).not.toContain("conv-infra");
    expect(String(await run("suggestion_list", {}, "conv-infra"))).not.toContain("sugg-1");
  });

  test("suggestion_withdraw takes back this chat's pending suggestion; another chat's fails, and a decided one fails with its status", async () => {
    const { run, records, suggestions } = suggesting();
    await run("suggestion_create", { title: "one", text: "x", target: { agent_id: FRIDAY, conversation_id: "conv-infra" } });
    await run("suggestion_create", { title: "two", text: "x", target: { agent_id: FRIDAY, conversation_id: "conv-infra" } });
    await expect(run("suggestion_withdraw", { id: "sugg-1" }, "conv-infra")).rejects.toThrow(/no suggestion sugg-1/);
    await suggestions.decide({ agent_id: FRIDAY, conversation_id: "conv-source" }, "sugg-2", "reject", "phone");
    await expect(run("suggestion_withdraw", { id: "sugg-2" })).rejects.toThrow(/already rejected from the phone/);
    expect(String(await run("suggestion_withdraw", { id: "sugg-1" }))).toContain("sugg-1");
    expect(records.get(`${FRIDAY}/conv-source`)?.map((s) => s.status)).toEqual(["withdrawn", "rejected"]);
  });

  test("a call from a background pass's chat fails", async () => {
    const { run } = suggesting();
    for (const tool of ["chat_list", "suggestion_create", "suggestion_list", "suggestion_withdraw"])
      await expect(run(tool, { title: "t", text: "x", target: { agent_id: FRIDAY, conversation_id: "conv-infra" }, id: "x" }, "reflection-1")).rejects.toThrow(
        /background pass/,
      );
  });

  test("all four only read, so no mode asks; suggestion_create says when to suggest", () => {
    const { tools } = suggesting();
    for (const name of ["chat_list", "suggestion_create", "suggestion_list", "suggestion_withdraw"])
      for (const mode of ["strict", "standard", "acceptEdits"] as const)
        expect(asks(mode, name, {}, { kind: kindOf(name, must(tools.get(name), name).annotations) })).toBe(false);
    const rule = must(tools.get("suggestion_create"), "suggestion_create").description;
    expect(rule).toMatch(/another chat/);
    expect(rule).toMatch(/never for work you can do in this chat/);
    expect(rule).toMatch(/chat_list/);
    expect(rule).toMatch(/suggestion_list/);
    expect(rule).toMatch(/absolute paths/);
  });
});
