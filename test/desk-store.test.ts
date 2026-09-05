import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DeskStore } from "../mod/desk-store.ts";
import { loadDesks, persistDesks } from "../mod/persist.ts";

describe("DeskStore", () => {
  test("gesture commits and notifies; unchanged states do not notify", () => {
    const store = new DeskStore();
    const seen: string[] = [];
    store.subscribe((scope, state) => seen.push(`${scope}:${state.rev}`));
    store.gesture("d", { kind: "move", id: "d/a", position: { x: 1, y: 1 } });
    store.seen("d", "d/a"); // already has layout → no change
    store.fileChanged("d", "d/a"); // no overlay, not hidden → no change
    expect(seen).toEqual(["d:2"]);
  });

  test("seen places a conversation desk's widgets clear of the shared ones; measure and arrange", () => {
    const store = new DeskStore();
    store.seen("shared", "shared/welcome");
    store.measure("shared", "shared/welcome", { w: 280, h: 200 });
    store.seen("c1", "c1/a");
    expect(store.get("shared").layout["shared/welcome"].position).toEqual({ x: 120, y: 120 });
    expect(store.get("c1").layout["c1/a"].position).toEqual({ x: 424, y: 120 });
    // pile two more on top by hand, then arrange
    store.gesture("c1", { kind: "move", id: "c1/b", position: { x: 424, y: 130 } });
    store.gesture("c1", { kind: "move", id: "c1/c", position: { x: 430, y: 140 } });
    store.arrange("c1");
    const ps = ["c1/a", "c1/b", "c1/c"].map((id) => store.get("c1").layout[id].position);
    expect(new Set(ps.map((p) => `${p.x},${p.y}`)).size).toBe(3);
    expect(ps.every((p) => !(p.x < 400 && p.y < 320))).toBe(true); // none over the shared widget
  });

  test("a new shared widget avoids widgets on every desk", () => {
    const store = new DeskStore();
    store.seen("c1", "c1/a"); // (120,120)
    store.seen("c2", "c2/a"); // (120,120) too — different desk, never shown together
    store.seen("shared", "shared/w");
    const p = store.get("shared").layout["shared/w"].position;
    expect(p).not.toEqual({ x: 120, y: 120 });
  });

  test("fileChanged clears overlay and reveals", () => {
    const store = new DeskStore();
    store.gesture("d", { kind: "set", id: "d/a", path: "v", value: 2 });
    store.gesture("d", { kind: "close", id: "d/a" });
    store.fileChanged("d", "d/a");
    expect(store.get("d").overlay["d/a"]).toBeUndefined();
    expect(store.get("d").layout["d/a"].hidden).toBe(false);
  });
});

describe("persistence", () => {
  test("empty desks are never written; non-empty desks round-trip", async () => {
    const dir = mkdtempSync(join(tmpdir(), "loci-persist-"));
    try {
      const store = new DeskStore();
      const stop = persistDesks(store, dir, 10);
      store.subscribe(() => {}); // noop
      // a scope with nothing in it: no file
      expect(store.get("empty").rev).toBe(0);
      store.gesture("conv1", { kind: "move", id: "conv1/w", position: { x: 9, y: 9 } });
      await new Promise((r) => setTimeout(r, 40));
      expect(existsSync(join(dir, "conv1.json"))).toBe(true);
      expect(existsSync(join(dir, "empty.json"))).toBe(false);
      stop();
      const parsed = JSON.parse(readFileSync(join(dir, "conv1.json"), "utf8"));
      expect(parsed.layout["conv1/w"].position).toEqual({ x: 9, y: 9 });

      const fresh = new DeskStore();
      expect(loadDesks(fresh, dir)).toEqual(["conv1"]);
      expect(fresh.get("conv1").layout["conv1/w"].position).toEqual({ x: 9, y: 9 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("corrupt snapshot files are skipped", () => {
    const dir = mkdtempSync(join(tmpdir(), "loci-persist-"));
    try {
      Bun.write(join(dir, "bad.json"), "{not json");
      const store = new DeskStore();
      expect(loadDesks(store, dir)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
