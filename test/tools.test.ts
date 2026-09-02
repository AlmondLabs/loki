import { describe, expect, test } from "bun:test";
import { DeskStore } from "../src/store";
import { registerTools } from "../src/tools";

type Tool = {
  name: string;
  run(ctx: { args: Record<string, unknown> }): unknown;
};

function setup() {
  const store = new DeskStore();
  const broadcasts: object[] = [];
  const tools: Tool[] = [];
  const letta = {
    capabilities: { tools: true },
    tools: {
      register(tool: Tool) {
        tools.push(tool);
        return () => {};
      },
    },
  };
  registerTools(letta as never, store, (msg) => broadcasts.push(msg));
  const byName = (name: string) => tools.find((t) => t.name === name)!;
  return { store, broadcasts, render: byName("loci_render"), state: byName("loci_state") };
}

describe("loci_render", () => {
  test("adds a widget, broadcasts the patch, returns a summary", () => {
    const { store, broadcasts, render } = setup();
    const result = render.run({
      args: { type: "info-card", title: "Spain Trip", data: { lines: ["66 days"] } },
    });
    expect(String(result)).toContain("spain-trip");
    expect(store.get().widgets["spain-trip"].data).toEqual({ lines: ["66 days"] });
    expect(broadcasts).toHaveLength(1);
  });

  test("duplicate titles get unique ids", () => {
    const { store, render } = setup();
    render.run({ args: { type: "info-card", title: "Card", data: { lines: [] } } });
    render.run({ args: { type: "info-card", title: "Card", data: { lines: [] } } });
    expect(store.get().widgets["card"]).toBeDefined();
    expect(store.get().widgets["card-2"]).toBeDefined();
  });

  test("unknown type / bad args return usable errors without crashing", () => {
    const { render, broadcasts } = setup();
    const bad = render.run({ args: { type: "hologram", title: "x", data: {} } }) as {
      status: string;
      content: string;
    };
    expect(bad.status).toBe("error");
    expect(bad.content).toContain("info-card");

    const noTitle = render.run({ args: { type: "info-card", title: " ", data: {} } }) as {
      status: string;
    };
    expect(noTitle.status).toBe("error");
    expect(broadcasts).toHaveLength(0);
  });

  test("respects explicit position", () => {
    const { store, render } = setup();
    render.run({
      args: { type: "info-card", title: "Here", data: { lines: [] }, position: { x: 9, y: 7 } },
    });
    expect(store.get().widgets["here"].position).toEqual({ x: 9, y: 7 });
  });
});

describe("loci_state", () => {
  test("returns widgets as JSON", () => {
    const { render, state } = setup();
    render.run({ args: { type: "info-card", title: "A", data: { lines: ["x"] } } });
    const parsed = JSON.parse(String(state.run({ args: {} })));
    expect(parsed.widgets).toHaveLength(1);
    expect(parsed.widgets[0].id).toBe("a");
  });
});

describe("capability gating", () => {
  test("no tools capability → registers nothing", () => {
    const store = new DeskStore();
    const disposers = registerTools({ capabilities: {} } as never, store, () => {});
    expect(disposers).toHaveLength(0);
  });
});
