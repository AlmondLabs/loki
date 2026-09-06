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
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
