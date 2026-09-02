import { describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { DeskStore } from "../src/store";
import { loadSnapshot, persistOnChange } from "../src/persist";

const TMP = "/tmp/loci-test-persist/desk.json";

const addCard = (id: string) =>
  ({
    op: "add",
    widget: { id, type: "info-card", title: id, position: { x: 0, y: 0 }, data: { lines: [] } },
  }) as const;

describe("persistence", () => {
  test("snapshot round-trip: mutate → flush → load into a fresh store", async () => {
    rmSync(TMP, { force: true });
    const store = new DeskStore();
    const stop = persistOnChange(store, TMP);
    store.apply(addCard("a"));
    store.apply({ op: "move", id: "a", position: { x: 42, y: 7 } });
    stop(); // flushes pending snapshot synchronously

    const fresh = new DeskStore();
    expect(loadSnapshot(fresh, TMP)).toBe(true);
    expect(fresh.get().widgets.a.position).toEqual({ x: 42, y: 7 });
    expect(fresh.get().rev).toBe(2);
  });

  test("missing snapshot → false, store untouched", () => {
    const store = new DeskStore();
    expect(loadSnapshot(store, "/tmp/loci-test-persist/nope.json")).toBe(false);
    expect(Object.keys(store.get().widgets)).toHaveLength(0);
  });

  test("corrupt snapshot → false, no crash", async () => {
    const { writeFileSync, mkdirSync } = await import("node:fs");
    mkdirSync("/tmp/loci-test-persist", { recursive: true });
    writeFileSync("/tmp/loci-test-persist/corrupt.json", "{not json");
    const store = new DeskStore();
    expect(loadSnapshot(store, "/tmp/loci-test-persist/corrupt.json")).toBe(false);
  });

  test("debounce collapses rapid patches into one flush", async () => {
    rmSync(TMP, { force: true });
    const store = new DeskStore();
    const stop = persistOnChange(store, TMP);
    for (let i = 0; i < 20; i++) {
      store.apply({ op: "add", widget: { id: `w${i}`, type: "info-card", title: `w${i}`, position: { x: i, y: i }, data: {} } });
    }
    await new Promise((r) => setTimeout(r, 350));
    const fresh = new DeskStore();
    expect(loadSnapshot(fresh, TMP)).toBe(true);
    expect(Object.keys(fresh.get().widgets)).toHaveLength(20);
    stop();
  });
});
