import { describe, expect, test } from "bun:test";
import { DeskStore, seedDesk, type Patch } from "../src/store";

const addCard = (id: string): Patch => ({
  op: "add",
  widget: {
    id,
    type: "info-card",
    title: id,
    position: { x: 0, y: 0 },
    data: { lines: [] },
  },
});

describe("DeskStore", () => {
  test("add assigns increasing z; duplicate add throws", () => {
    const store = new DeskStore();
    store.apply(addCard("a"));
    store.apply(addCard("b"));
    const desk = store.get();
    expect(desk.widgets.b.z).toBeGreaterThan(desk.widgets.a.z);
    expect(() => store.apply(addCard("a"))).toThrow("widget exists");
  });

  test("move updates position; unknown id throws", () => {
    const store = new DeskStore();
    store.apply(addCard("a"));
    store.apply({ op: "move", id: "a", position: { x: 50, y: 60 } });
    expect(store.get().widgets.a.position).toEqual({ x: 50, y: 60 });
    expect(() => store.apply({ op: "move", id: "ghost", position: { x: 0, y: 0 } })).toThrow(
      "no widget",
    );
  });

  test("focus bumps to front only when not already on top", () => {
    const store = new DeskStore();
    store.apply(addCard("a"));
    store.apply(addCard("b"));
    const zBefore = store.get().widgets.b.z;
    store.apply({ op: "focus", id: "b" });
    expect(store.get().widgets.b.z).toBe(zBefore); // already top: no bump
    store.apply({ op: "focus", id: "a" });
    expect(store.get().widgets.a.z).toBeGreaterThan(store.get().widgets.b.z);
  });

  test("close removes the widget", () => {
    const store = new DeskStore();
    store.apply(addCard("a"));
    store.apply({ op: "close", id: "a" });
    expect(store.get().widgets.a).toBeUndefined();
  });

  test("set writes a dot-path into data, creating objects", () => {
    const store = new DeskStore();
    store.apply(addCard("a"));
    store.apply({ op: "set", id: "a", path: "alloc.debt", value: 12 });
    expect((store.get().widgets.a.data as { alloc: { debt: number } }).alloc.debt).toBe(12);
  });

  test("rev increments per patch; listeners fire with the patch", () => {
    const store = new DeskStore();
    const seen: string[] = [];
    store.subscribe((_state, patch) => seen.push(patch.op));
    store.apply(addCard("a"));
    store.apply({ op: "move", id: "a", position: { x: 1, y: 1 } });
    expect(store.get().rev).toBe(2);
    expect(seen).toEqual(["add", "move"]);
  });

  test("scopes are isolated", () => {
    const store = new DeskStore();
    store.apply(addCard("a"), "conv-1");
    expect(store.get("conv-2").widgets.a).toBeUndefined();
    expect(store.get("conv-1").widgets.a).toBeDefined();
  });

  test("seedDesk is idempotent", () => {
    const store = new DeskStore();
    seedDesk(store);
    seedDesk(store);
    expect(Object.keys(store.get().widgets)).toHaveLength(1);
  });
});
