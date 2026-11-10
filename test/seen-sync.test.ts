import { describe, expect, test } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decayed } from "../core/attention/focus.ts";
import { LabelColors } from "../daemon/labels.ts";
import { SeenStore } from "../mod/seen.ts";
import { RETURN_TIMES_DEFAULT } from "../core/attention/rest.ts";
import type { Lane } from "../core/attention/lanes.ts";
import { seenFrames } from "../mod/frames/seen.ts";
import { must } from "./fixtures/must.ts";

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

describe("later rests and return times on two Macs (plan 070, U4)", () => {
  test("a later rest three weeks out syncs to a paired Mac and outlives its cleanup; the return times set later win", () => {
    const dir = mkdtempSync(join(tmpdir(), "loki-seen-sync-"));
    try {
      const mini = marks(dir, "mini");
      const book = marks(dir, "book");
      const far = { n: 2, until: "2026-12-08T10:00:00.000Z", stamp: "s", at: mini.clock.at, kind: "later" as const };
      mini.store.rest("agent-ira", "c1", far);
      expect(book.store.applyRemote(MINI, mini.store.snapshot())).toBe(true);
      book.clock.at = "2026-11-18T10:00:00.000Z"; // a month on; the rest ends in three weeks
      book.store.rest("agent-ira", "c2", { n: 1, until: "2026-11-18T11:00:00.000Z", stamp: "s", at: book.clock.at });
      expect(book.store.restsAll()["agent-ira/c1"]).toEqual(far);

      const times = { ...RETURN_TIMES_DEFAULT, read_first: { chat: "3h" as const, email: "10m" as const } };
      book.store.setReturnTimes(times);
      expect(mini.store.applyRemote(BOOK, book.store.snapshot())).toBe(true);
      expect(mini.store.returnTimes()).toEqual(times);
      mini.clock.at = "2026-11-18T09:00:00.000Z"; // set earlier than the MacBook's: it loses there
      mini.store.setReturnTimes(RETURN_TIMES_DEFAULT);
      expect(book.store.applyRemote(MINI, mini.store.snapshot())).toBe(false);
      expect(book.store.returnTimes()).toEqual(times);
      // A Mac from before return times sends none, and nothing moves.
      const { return_times: _, ...old } = mini.store.snapshot();
      expect(book.store.applyRemote(MINI, old)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("lanes on two Macs (plan 082, U3)", () => {
  const work: Lane = { id: "l-work", name: "Work", chats: ["agent-ira"], accounts: ["gmail:me@work.example"] };
  const home: Lane = { id: "l-home", name: "Home", chats: [], accounts: "all" };

  test("lanes set on one Mac reach the other through its marks", () => {
    const dir = mkdtempSync(join(tmpdir(), "loki-seen-sync-"));
    try {
      const mini = marks(dir, "mini");
      const book = marks(dir, "book");
      expect(book.store.lanes()).toEqual([]);
      expect(mini.store.setLanes([work, home])).toBe(true);
      expect(book.store.applyRemote(MINI, mini.store.snapshot())).toBe(true);
      expect(book.store.lanes()).toEqual([work, home]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a lane deleted later stays deleted on both Macs, and an older list arriving again changes nothing", () => {
    const dir = mkdtempSync(join(tmpdir(), "loki-seen-sync-"));
    try {
      const mini = marks(dir, "mini");
      const book = marks(dir, "book");
      book.store.setLanes([work, home]); // t1
      mini.store.applyRemote(BOOK, book.store.snapshot());
      const older = book.store.snapshot();
      mini.clock.at = "2026-10-18T10:05:00.000Z"; // t2 > t1
      mini.store.setLanes([home]);
      expect(book.store.applyRemote(MINI, mini.store.snapshot())).toBe(true);
      expect(mini.store.applyRemote(BOOK, book.store.snapshot())).toBe(false);
      expect(book.store.lanes()).toEqual([home]);
      expect(mini.store.lanes()).toEqual([home]);
      expect(mini.store.applyRemote(BOOK, older)).toBe(false);
      expect(mini.store.lanes()).toEqual([home]);
      // A Mac from before lanes sends none, and nothing moves.
      const { lanes: _, ...old } = mini.store.snapshot();
      expect(book.store.applyRemote(MINI, old)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the same lanes again report no change and push nothing; new ones push the whole marks", async () => {
    const dir = mkdtempSync(join(tmpdir(), "loki-seen-sync-"));
    try {
      const { store } = marks(dir, "mini");
      const pushed: unknown[] = [];
      const ctx = { broadcast: (f: unknown) => pushed.push(f) } as never;
      const set = must(seenFrames({ seen: store }).lanes_set, "the lanes_set handler");
      await set({ lanes: [work] }, ctx);
      expect(pushed).toEqual([expect.objectContaining({ type: "seen", lanes: [work] })]);
      expect(store.setLanes([work])).toBe(false);
      await set({ lanes: [work] }, ctx);
      expect(pushed).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a marks file from before lanes loads with none, and lanes set are written and read back", () => {
    const dir = mkdtempSync(join(tmpdir(), "loki-seen-sync-"));
    try {
      const path = join(dir, "attention.json");
      writeFileSync(path, JSON.stringify({ seen: { "agent-ira/c1": "2026-10-18T09:00:00.000Z" } }));
      const old = new SeenStore(path, { debounceMs: 0 });
      expect(old.lanes()).toEqual([]);
      expect(old.snapshot().lanes).toBeNull();
      old.setLanes([home]);
      old.flush();
      expect(new SeenStore(path, { debounceMs: 0 }).lanes()).toEqual([home]);
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
