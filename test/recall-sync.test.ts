import { describe, expect, test } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyRecall, recallSnapshot } from "../mod/recall-sync.ts";

/** A Learn file written at `at` (ms). */
function put(dir: string, path: string, text: string, at: number): void {
  mkdirSync(join(dir, path, ".."), { recursive: true });
  writeFileSync(join(dir, path), text);
  utimesSync(join(dir, path), new Date(at), new Date(at));
}

const T = Date.parse("2026-10-18T10:00:00Z");

describe("Learn's files on two Macs", () => {
  test("a card made on one Mac appears on the other, and the later edit wins either way", () => {
    const root = mkdtempSync(join(tmpdir(), "loki-recall-sync-"));
    const book = join(root, "book");
    const mini = join(root, "mini");
    try {
      put(book, "cards/c1.json", '{"front":"a"}', T);
      expect(applyRecall(mini, recallSnapshot(book, T), T)).toBe(true);
      expect(readFileSync(join(mini, "cards/c1.json"), "utf8")).toBe('{"front":"a"}');
      put(mini, "cards/c1.json", '{"front":"b"}', T + 60_000);
      expect(applyRecall(book, recallSnapshot(mini, T + 60_000), T + 60_000)).toBe(true);
      expect(readFileSync(join(book, "cards/c1.json"), "utf8")).toBe('{"front":"b"}');
      expect(applyRecall(mini, recallSnapshot(book, T + 60_000), T + 60_000)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a review on each Mac made apart keeps the later schedule", () => {
    const root = mkdtempSync(join(tmpdir(), "loki-recall-sync-"));
    const book = join(root, "book");
    const mini = join(root, "mini");
    try {
      put(book, "schedule/c1.json", '{"reps":2}', T + 5_000);
      put(mini, "schedule/c1.json", '{"reps":3}', T + 9_000);
      applyRecall(book, recallSnapshot(mini, T + 10_000), T + 10_000);
      applyRecall(mini, recallSnapshot(book, T + 10_000), T + 10_000);
      expect(readFileSync(join(book, "schedule/c1.json"), "utf8")).toBe('{"reps":3}');
      expect(readFileSync(join(mini, "schedule/c1.json"), "utf8")).toBe('{"reps":3}');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a card removed on one Mac is removed on the other and does not come back", () => {
    const root = mkdtempSync(join(tmpdir(), "loki-recall-sync-"));
    const book = join(root, "book");
    const mini = join(root, "mini");
    try {
      put(book, "cards/c1.json", '{"front":"a"}', T);
      recallSnapshot(book, T); // the MacBook has seen it
      applyRecall(mini, recallSnapshot(book, T), T);
      rmSync(join(book, "cards/c1.json"));
      expect(applyRecall(mini, recallSnapshot(book, T + 1000), T + 1000)).toBe(true);
      expect(existsSync(join(mini, "cards/c1.json"))).toBe(false);
      expect(applyRecall(book, recallSnapshot(mini, T + 2000), T + 2000)).toBe(false);
      expect(existsSync(join(book, "cards/c1.json"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a path outside Learn's folders is never written", () => {
    const root = mkdtempSync(join(tmpdir(), "loki-recall-sync-"));
    try {
      expect(applyRecall(root, { files: { "../x.json": { content: "{}", mtime: T }, "worker.json": { content: "{}", mtime: T } }, deleted: {} }, T)).toBe(
        false,
      );
      expect(existsSync(join(root, "worker.json"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
