import { describe, expect, test } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SeenStore } from "../mod/seen.ts";

/** The attention file as the store wrote it. */
const written = (path: string) =>
  JSON.parse(readFileSync(path, "utf8")) as { seen?: Record<string, string>; viewed?: Record<string, string>; snooze?: unknown; ladder?: unknown };

describe("seen store", () => {
  test("reads the v1 flat file and writes { seen }", () => {
    const dir = mkdtempSync(join(tmpdir(), "loki-seen-"));
    try {
      const path = join(dir, "attention.json");
      writeFileSync(path, JSON.stringify({ "a/c1": "2026-09-05T10:00:00Z" }));
      const store = new SeenStore(path);
      expect(store.all()).toEqual({ "a/c1": "2026-09-05T10:00:00Z" });
      store.mark("a", "c2");
      store.flush(); // writes are coalesced; flush is what the mod's shutdown calls
      const file = written(path);
      expect(Object.keys(file)).toEqual(["seen"]);
      expect(file.seen?.["a/c1"]).toBe("2026-09-05T10:00:00Z");
      expect(new SeenStore(path).all()).toEqual(file.seen);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("an older file with deferrals and a ladder loads its markers and drops the rest on the next write", () => {
    const dir = mkdtempSync(join(tmpdir(), "loki-seen-"));
    try {
      const path = join(dir, "attention.json");
      const snooze = { "a/c2": { skips: 2, until: "2026-09-05T10:15:00Z", stamp: "s", at: "2026-09-05T10:00:00Z" } };
      writeFileSync(
        path,
        JSON.stringify({
          seen: { "a/c1": "2026-09-05T10:00:00Z" },
          viewed: { "a/c1": "2026-09-05T10:01:00Z" },
          snooze,
          ladder: { firstMinutes: 5, growth: 3 },
        }),
      );
      const store = new SeenStore(path);
      expect(store.all()).toEqual({ "a/c1": "2026-09-05T10:00:00Z" });
      expect(store.viewedAll()).toEqual({ "a/c1": "2026-09-05T10:01:00Z" });
      store.mark("a", "c3");
      store.flush();
      const file = written(path);
      expect(file.snooze).toBeUndefined();
      expect(file.ladder).toBeUndefined();
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
      expect(written(path).viewed).toBeUndefined();
      expect(store.viewedAll()).toEqual({});
      store.view("a", "c1");
      const at = store.viewedAll()["a/c1"];
      expect(typeof at).toBe("string");
      expect(Number.isFinite(Date.parse(at))).toBe(true);
      store.flush();
      expect(written(path).viewed).toEqual({ "a/c1": at });
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
      store.flush();
      writeFileSync(path, "untouched"); // any write from here on would replace this
      expect(store.view("a", "c1")).toBe(false); // the same instant again
      expect(store.mark("a", "c1")).toBe(false);
      expect(store.unmark("a", "c2")).toBe(false); // not done already
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
      await new Promise((r) => setTimeout(r, 80));
      expect(written(path).viewed).toEqual({ "a/c1": "2026-09-25T10:00:02.000Z" }); // the last of the burst
      store.mark("a", "c1");
      store.flush(); // the mod's shutdown
      expect(written(path).seen).toEqual({ "a/c1": "2026-09-25T10:00:03.000Z" });
      expect(new SeenStore(path).all()).toEqual({ "a/c1": "2026-09-25T10:00:03.000Z" });
    }));
});
