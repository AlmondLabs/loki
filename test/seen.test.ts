import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SeenStore } from "../mod/seen.ts";

describe("seen store", () => {
  test("reads the v1 flat file, writes { seen, snooze }, and keeps deferrals", () => {
    const dir = mkdtempSync(join(tmpdir(), "loki-seen-"));
    try {
      const path = join(dir, "attention.json");
      writeFileSync(path, JSON.stringify({ "a/c1": "2026-09-05T10:00:00Z" }));
      const store = new SeenStore(path);
      expect(store.all()).toEqual({ "a/c1": "2026-09-05T10:00:00Z" });
      const rec = { skips: 2, until: "2026-09-05T10:15:00Z", stamp: "s", at: "2026-09-05T10:00:00Z" };
      store.setSnooze("a", "c2", rec);
      store.flush(); // writes are coalesced; flush is what the mod's shutdown calls
      expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ seen: { "a/c1": "2026-09-05T10:00:00Z" }, snooze: { "a/c2": rec } });
      const again = new SeenStore(path);
      expect(again.snoozes()).toEqual({ "a/c2": rec });
      again.clearSnooze("a", "c2");
      again.flush();
      expect(new SeenStore(path).snoozes()).toEqual({});
      // the "later" ladder: defaults until set; each knob clamped; persisted beside the markers; only written once set
      expect(again.ladder()).toEqual({ firstMinutes: 10, growth: 3 });
      expect(JSON.parse(readFileSync(path, "utf8")).ladder).toBeUndefined();
      expect(again.setLadder({ firstMinutes: 5 })).toEqual({ firstMinutes: 5, growth: 3 });
      expect(again.setLadder({ growth: 20 })).toEqual({ firstMinutes: 5, growth: 10 });
      again.flush();
      expect(new SeenStore(path).ladder()).toEqual({ firstMinutes: 5, growth: 10 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("viewed markers", () => {
  test("a look is kept beside seen, survives a reload, is left alone by unmark, and is only written once there is one", () => {
    const dir = mkdtempSync(join(tmpdir(), "loki-seen-"));
    try {
      const path = join(dir, "attention.json");
      const store = new SeenStore(path);
      store.mark("a", "c1");
      store.flush();
      expect(JSON.parse(readFileSync(path, "utf8")).viewed).toBeUndefined();
      expect(store.viewedAll()).toEqual({});
      store.view("a", "c1");
      const at = store.viewedAll()["a/c1"];
      expect(typeof at).toBe("string");
      expect(Number.isFinite(Date.parse(at))).toBe(true);
      store.flush();
      expect(JSON.parse(readFileSync(path, "utf8")).viewed).toEqual({ "a/c1": at });
      // "not done" undoes done, never the look
      store.unmark("a", "c1");
      store.flush();
      const again = new SeenStore(path);
      expect(again.all()).toEqual({});
      expect(again.viewedAll()).toEqual({ "a/c1": at });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("a mark that changes nothing, and the coalesced write", () => {
  const withDir = async (fn: (path: string) => void | Promise<void>) => {
    const dir = mkdtempSync(join(tmpdir(), "loki-seen-"));
    try {
      await fn(join(dir, "attention.json"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  test("an unchanged mark reports no change and writes nothing", () =>
    withDir((path) => {
      const store = new SeenStore(path, { now: () => "2026-09-25T10:00:00.000Z" });
      expect(store.view("a", "c1")).toBe(true);
      expect(store.mark("a", "c1")).toBe(true);
      const rec = { skips: 1, until: "2026-09-25T10:10:00Z", stamp: "s", at: "2026-09-25T10:00:00Z" };
      expect(store.setSnooze("a", "c1", rec)).toBe(true);
      store.flush();
      writeFileSync(path, "untouched"); // any write from here on would replace this
      expect(store.view("a", "c1")).toBe(false); // the same instant again
      expect(store.mark("a", "c1")).toBe(false);
      expect(store.unmark("a", "c2")).toBe(false); // not done already
      expect(store.setSnooze("a", "c1", { ...rec })).toBe(false);
      expect(store.clearSnooze("a", "c2")).toBe(false);
      store.setLadder({ firstMinutes: 10, growth: 3 }); // the defaults, stored as they are shown
      const before = readFileSync(path, "utf8");
      store.setLadder({ firstMinutes: 10, growth: 3 });
      store.flush();
      expect(before).toBe("untouched");
      expect(readFileSync(path, "utf8")).not.toBe("untouched"); // the first setLadder stored a setting
      writeFileSync(path, "untouched");
      store.setLadder({ firstMinutes: 10, growth: 3 });
      store.flush();
      expect(readFileSync(path, "utf8")).toBe("untouched");
    }));

  test("marks in a burst are written once, after the debounce; flush writes at once", () =>
    withDir(async (path) => {
      let tick = 0;
      const store = new SeenStore(path, { debounceMs: 40, now: () => new Date(Date.UTC(2026, 8, 25, 10, 0, tick++)).toISOString() });
      store.view("a", "c1");
      store.view("a", "c1");
      store.view("a", "c1");
      expect(() => readFileSync(path, "utf8")).toThrow(); // nothing on disk yet
      await Bun.sleep(80);
      expect(JSON.parse(readFileSync(path, "utf8")).viewed).toEqual({ "a/c1": "2026-09-25T10:00:02.000Z" }); // the last of the burst
      store.mark("a", "c1");
      store.flush(); // the mod's shutdown
      expect(JSON.parse(readFileSync(path, "utf8")).seen).toEqual({ "a/c1": "2026-09-25T10:00:03.000Z" });
      expect(new SeenStore(path).all()).toEqual({ "a/c1": "2026-09-25T10:00:03.000Z" });
    }));
});
