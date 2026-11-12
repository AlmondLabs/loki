import { describe, expect, test } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyFiles, applyRecall, filesSnapshot, recallSnapshot, type SyncedFiles } from "../mod/recall-sync.ts";

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

describe("a mod's files on two Macs", () => {
  /** A mods folder's files, as peering lists them: every file directly in it. */
  const MODS: SyncedFiles = {
    list: (dir) => Object.fromEntries(["icon.png", "mod.ts"].filter((n) => existsSync(join(dir, n))).map((n) => [n, T])),
    safe: (path) => /^[\w.-]+$/.test(path),
  };

  test("a picture or any file that is not text arrives byte for byte; text still travels as text", () => {
    const root = mkdtempSync(join(tmpdir(), "loki-mod-sync-"));
    const book = join(root, "book");
    const mini = join(root, "mini");
    try {
      // A PNG's first bytes: 0x89 alone is not UTF-8, so read as text it became a replacement character.
      const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff, 0xfe]);
      mkdirSync(book, { recursive: true });
      writeFileSync(join(book, "icon.png"), png);
      writeFileSync(join(book, "mod.ts"), "export default () => {}; // ünïcode");
      const snap = filesSnapshot(book, MODS, T);
      expect(snap.files["icon.png"].encoding).toBe("base64");
      expect(snap.files["mod.ts"].encoding).toBeUndefined();
      expect(applyFiles(mini, MODS, snap, T)).toBe(true);
      expect(readFileSync(join(mini, "icon.png")).equals(png)).toBe(true);
      expect(readFileSync(join(mini, "mod.ts"), "utf8")).toBe("export default () => {}; // ünïcode");
      // A Mac on an older loki sends no mark: its text is written as text.
      expect(applyFiles(mini, MODS, { files: { "mod.ts": { content: "old", mtime: T + 1 } }, deleted: {} }, T + 1)).toBe(true);
      expect(readFileSync(join(mini, "mod.ts"), "utf8")).toBe("old");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
