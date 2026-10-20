import { describe, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decayed } from "../core/attention/focus.ts";
import { LabelColors } from "../daemon/labels.ts";
import { SeenStore } from "../mod/seen.ts";

const BOOK = "aaaaaaaa-1111-4111-8111-111111111111";
const MINI = "bbbbbbbb-2222-4222-8222-222222222222";

/** A marks store whose clock the test sets. */
function marks(dir: string, name: string) {
  const clock = { at: "2026-10-18T10:00:00.000Z" };
  return { clock, store: new SeenStore(join(dir, `${name}.json`), { debounceMs: 0, now: () => clock.at }) };
}

describe("Inbox marks on two Macs", () => {
  test("done on the mini at 10:00, not done on the MacBook at 10:01: not done on both (AE4)", () => {
    const dir = mkdtempSync(join(tmpdir(), "loki-seen-sync-"));
    try {
      const mini = marks(dir, "mini");
      const book = marks(dir, "book");
      mini.store.mark("agent-ira", "c1");
      book.store.applyRemote(MINI, mini.store.snapshot());
      expect(book.store.all()).toHaveProperty("agent-ira/c1");
      book.clock.at = "2026-10-18T10:01:00.000Z";
      book.store.unmark("agent-ira", "c1");
      expect(mini.store.applyRemote(BOOK, book.store.snapshot())).toBe(true);
      expect(mini.store.all()).not.toHaveProperty("agent-ira/c1");
      expect(book.store.all()).not.toHaveProperty("agent-ira/c1");
      // Done again later anywhere wins over that.
      mini.clock.at = "2026-10-18T10:02:00.000Z";
      mini.store.mark("agent-ira", "c1");
      book.store.applyRemote(MINI, mini.store.snapshot());
      expect(book.store.all()).toHaveProperty("agent-ira/c1");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("focus added on both Macs sums on both; a rest set later on either Mac wins on both", () => {
    const dir = mkdtempSync(join(tmpdir(), "loki-seen-sync-"));
    try {
      const mini = marks(dir, "mini");
      const book = marks(dir, "book");
      mini.store.engage("agent-ira", "c1", "message");
      book.store.engage("agent-ira", "c1", "answer");
      book.store.applyRemote(MINI, mini.store.snapshot());
      mini.store.applyRemote(BOOK, book.store.snapshot());
      const at = Date.parse(book.clock.at);
      expect(decayed(book.store.focusAll()["agent-ira/c1"], at)).toBeCloseTo(2);
      expect(decayed(mini.store.focusAll()["agent-ira/c1"], at)).toBeCloseTo(2);
      const first = { n: 1, until: "2026-10-18T10:10:00.000Z", stamp: "s", at: "2026-10-18T10:00:00.000Z" };
      const second = { n: 2, until: "2026-10-18T10:40:00.000Z", stamp: "s", at: "2026-10-18T10:10:00.000Z" };
      expect(mini.store.rest("agent-ira", "c1", second)).toBe(true);
      expect(book.store.rest("agent-ira", "c1", first)).toBe(true);
      expect(book.store.applyRemote(MINI, mini.store.snapshot())).toBe(true);
      expect(mini.store.applyRemote(BOOK, book.store.snapshot())).toBe(false);
      expect(book.store.restsAll()["agent-ira/c1"]).toEqual(second);
      expect(mini.store.restsAll()["agent-ira/c1"]).toEqual(second);
      // An earlier rest arriving late changes nothing; a Mac from before rests sends none.
      expect(book.store.rest("agent-ira", "c1", first)).toBe(false);
      const { rests: _, ...old } = mini.store.snapshot();
      expect(book.store.applyRemote(MINI, old)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("label colours on two Macs", () => {
  test("a colour chosen later wins; one given automatically yields to a chosen one", () => {
    const book = new LabelColors(undefined, () => "2026-10-18T10:00:00.000Z");
    const mini = new LabelColors(undefined, () => "2026-10-18T11:00:00.000Z");
    book.colorOf("infra");
    mini.colorOf("infra");
    mini.set("infra", 5);
    expect(book.apply(mini.snapshot())).toBe(true);
    expect(book.colorOf("infra")).toBe(5);
    book.set("infra", 2); // chosen at 10:00, before the mini's 11:00
    expect(mini.apply(book.snapshot())).toBe(false);
    expect(mini.colorOf("infra")).toBe(5);
  });
});
