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
      expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ seen: { "a/c1": "2026-09-05T10:00:00Z" }, snooze: { "a/c2": rec } });
      const again = new SeenStore(path);
      expect(again.snoozes()).toEqual({ "a/c2": rec });
      again.clearSnooze("a", "c2");
      expect(new SeenStore(path).snoozes()).toEqual({});
      // the "later" ladder: defaults until set; each knob clamped; persisted beside the markers; only written once set
      expect(again.ladder()).toEqual({ firstMinutes: 10, growth: 3 });
      expect(JSON.parse(readFileSync(path, "utf8")).ladder).toBeUndefined();
      expect(again.setLadder({ firstMinutes: 5 })).toEqual({ firstMinutes: 5, growth: 3 });
      expect(again.setLadder({ growth: 20 })).toEqual({ firstMinutes: 5, growth: 10 });
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
      expect(JSON.parse(readFileSync(path, "utf8")).viewed).toBeUndefined();
      expect(store.viewedAll()).toEqual({});
      store.view("a", "c1");
      const at = store.viewedAll()["a/c1"];
      expect(typeof at).toBe("string");
      expect(Number.isFinite(Date.parse(at))).toBe(true);
      expect(JSON.parse(readFileSync(path, "utf8")).viewed).toEqual({ "a/c1": at });
      // "not done" undoes done, never the look
      store.unmark("a", "c1");
      const again = new SeenStore(path);
      expect(again.all()).toEqual({});
      expect(again.viewedAll()).toEqual({ "a/c1": at });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
