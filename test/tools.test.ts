import { describe, expect, test } from "bun:test";
import { registerTools, type ToolDeps } from "../mod/tools.ts";
import { DeskStore } from "../mod/desk-store.ts";
import { GestureLog } from "../mod/gestures.ts";
import type { LettaMod, ToolDefinition } from "../mod/letta-types.ts";
import type { WidgetManifestEntry } from "../shared/desk-core.ts";

const sleep: WidgetManifestEntry = {
  id: "c1/sleep", scope: "c1", name: "sleep", kind: "json", file: "c1/sleep.json", title: "Sleep", type: "slider-control",
  data: { value: 6 }, hash: "h", updatedAt: 0, error: "missing \"title\"",
};
const welcome: WidgetManifestEntry = { ...sleep, id: "shared/welcome", scope: "shared", name: "welcome", file: "shared/welcome.json", title: "loci", type: "info-card", data: { lines: ["a"] }, error: undefined };

function harness(deps?: Partial<ToolDeps>) {
  const tools = new Map<string, ToolDefinition>();
  const letta = {
    capabilities: { commands: true, tools: true },
    tools: { register: (t: ToolDefinition) => void tools.set(t.name, t) },
    commands: { register: () => {} },
  } as unknown as LettaMod;
  const store = new DeskStore();
  store.gesture("c1", { kind: "set", id: "c1/sleep", path: "value", value: 7 });
  const gestures = new GestureLog();
  gestures.record("c1", "moved something");
  const broadcasts: Array<[unknown, string | undefined]> = [];
  const entries = [sleep, welcome];
  registerTools(letta, {
    store,
    gestures,
    widgets: {
      entries: (s) => entries.filter((e) => !s || e.scope === s),
      get: (id) => entries.find((e) => e.id === id),
      setRuntimeError: () => false,
      rescan: async () => {},
      close() {},
    },
    widgetsDir: "/proj/app/src/widgets",
    activeScope: () => "c1",
    broadcast: (m, s) => broadcasts.push([m, s]),
    ...deps,
  });
  return { tools, broadcasts };
}

describe("desk_state", () => {
  test("returns own desk + shared, merged data, layout, errors, pending activity", async () => {
    const { tools } = harness();
    const out = JSON.parse((await tools.get("desk_state")!.run({ args: {} })) as string);
    expect(out.desk).toBe("c1");
    expect(out.widgetsDir).toBe("/proj/app/src/widgets/c1");
    expect(out.widgets[0]).toMatchObject({ id: "c1/sleep", file: "/proj/app/src/widgets/c1/sleep.json", data: { value: 7 }, error: 'missing "title"' });
    expect(out.shared[0]).toMatchObject({ id: "shared/welcome", data: { lines: ["a"] } });
    expect(out.shared[0].error).toBeUndefined();
    expect(out.pendingCanvasActivity).toEqual(["moved something"]);
  });
  test("the desk comes from the calling conversation, not the mod's active desk", async () => {
    const remembered: string[] = [];
    const { tools } = harness({ remember: (id) => (remembered.push(id), id.replace(/[^a-zA-Z0-9_-]/g, "_")) });
    const out = JSON.parse((await tools.get("desk_state")!.run({ args: {}, conversation: { id: "local-conv-1291", sendMessageStream: async () => (async function* () {})() } })) as string);
    expect(out.desk).toBe("local-conv-1291"); // not "c1", the active desk in this harness
    expect(remembered).toEqual(["local-conv-1291"]);
    const explicit = JSON.parse((await tools.get("desk_state")!.run({ args: { desk: "shared" }, conversation: { id: "local-conv-1291", sendMessageStream: async () => (async function* () {})() } })) as string);
    expect(explicit.desk).toBe("shared");
  });

  test("explicit desk=shared returns only the shared desk", async () => {
    const { tools } = harness();
    const out = JSON.parse((await tools.get("desk_state")!.run({ args: { desk: "shared" } })) as string);
    expect(out.desk).toBe("shared");
    expect(out.shared).toBeUndefined();
    expect(out.widgets.map((w: { id: string }) => w.id)).toEqual(["shared/welcome"]);
  });
  test("description tells the agent to write files, not to look for a render tool", () => {
    const { tools } = harness();
    expect(tools.get("desk_state")!.description).toMatch(/write a file/);
    expect(tools.get("desk_state")!.description).toMatch(/@loci\/kit/);
  });
});

describe("loci_camera", () => {
  test("broadcasts to the widget's desk; shared goes to everyone; missing errors", async () => {
    const { tools, broadcasts } = harness();
    const cam = tools.get("loci_camera")!;
    expect(await cam.run({ args: { widgetId: "c1/sleep" } })).toMatch(/gliding/);
    expect(broadcasts[0]).toEqual([{ type: "camera", widgetId: "c1/sleep", widgetIds: ["c1/sleep"] }, "c1"]);
    await cam.run({ args: { widgetId: "shared/welcome" } });
    expect(broadcasts[1][1]).toBeUndefined();
    expect(await cam.run({ args: { widgetId: "nope" } })).toMatchObject({ status: "error" });
    expect(await cam.run({ args: {} })).toMatchObject({ status: "error" });
  });

  test("frames several widgets and honours dwell", async () => {
    const { tools, broadcasts } = harness();
    const cam = tools.get("loci_camera")!;
    const t = Date.now();
    const out = await cam.run({ args: { widgetIds: ["c1/sleep", "shared/welcome"], dwell: 120 } });
    expect(Date.now() - t).toBeGreaterThanOrEqual(110);
    expect(out).toMatch(/framing 2 widgets, held 120ms/);
    expect(broadcasts[0]).toEqual([{ type: "camera", widgetId: "c1/sleep", widgetIds: ["c1/sleep", "shared/welcome"] }, undefined]);
  });
  test("no tools capability → nothing registered", () => {
    const tools = new Map();
    registerTools({ capabilities: { commands: true }, commands: { register: () => {} } } as unknown as LettaMod, {} as ToolDeps);
    expect(tools.size).toBe(0);
  });
});
