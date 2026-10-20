import { describe, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SeenStore } from "../mod/seen.ts";
import { inboxQueue, restingCount } from "../core/attention/queue.ts";
import { REST_CAP_MS, REST_FIRST_MS, isResting, movesOn, restAfterNext, restState, restUndone, rungMs, type Rest } from "../core/attention/rest.ts";
import { EMPTY_DECK, commitCard, deckQueue, throughResting } from "../app/src/phone/deck.ts";
import { attentionItem } from "./fixtures/attention.ts";
import { must } from "./fixtures/must.ts";

/** Rest (core/attention/rest.ts, plan 026): Next on a stale card hides it, longer each time, until something new comes. */

const MIN = 60_000;
const H = 60 * MIN;
const T0 = Date.parse("2026-10-20T09:00:00Z");
/** A card with nothing new, its chat quiet for `quiet` ms at T0. */
const stale = (id = "c1", quiet = 0) => attentionItem(id, { unread: false, status: "idle", last_message_at: new Date(T0 - quiet).toISOString() });
const gap = (r: Rest | null, at = T0) => Date.parse(must(r, "a rest").until) - at;

describe("the ladder", () => {
  test("each Next in a row on a stale card rests it three times longer, up to a week", () => {
    expect([1, 2, 3, 4, 5, 6].map((n) => rungMs(n) / MIN)).toEqual([10, 30, 90, 270, 810, 2430]);
    expect(rungMs(20)).toBe(REST_CAP_MS);
    let rest: Rest | null = null;
    const gaps: number[] = [];
    for (let i = 0; i < 3; i++) {
      rest = restAfterNext(stale(), rest ?? undefined, false, T0);
      gaps.push(gap(rest) / MIN);
    }
    expect(gaps).toEqual([10, 30, 90]);
    expect(must(rest, "a rest").n).toBe(3);
  });

  test("a chat quiet for two days rests two days more; one quiet a month, a week", () => {
    expect(gap(restAfterNext(stale("c1", 48 * H), undefined, false, T0))).toBe(48 * H);
    expect(gap(restAfterNext(stale("c1", 30 * 24 * H), undefined, false, T0))).toBe(REST_CAP_MS);
  });

  test("a card with something new, or a Next straight after replying, rests ten minutes and does not climb", () => {
    const fresh = attentionItem("c1", { last_message_at: new Date(T0 - 48 * H).toISOString() });
    const read = restAfterNext(fresh, undefined, false, T0);
    expect([gap(read), must(read, "a rest").n]).toEqual([REST_FIRST_MS, 0]);
    const onRung2: Rest = { n: 2, until: new Date(T0).toISOString(), stamp: must(restAfterNext(stale(), undefined, false, T0), "a rest").stamp, at: "" };
    const movedOn = restAfterNext(stale(), onRung2, true, T0);
    expect([gap(movedOn), must(movedOn, "a rest").n]).toEqual([REST_FIRST_MS, 2]);
    expect(movesOn({ id: "a1/c1", action: "reply" }, "a1/c1")).toBe(true);
    expect(movesOn({ id: "a1/c1", action: "next" }, "a1/c1")).toBe(false);
    expect(movesOn({ id: "a1/c2", action: "reply" }, "a1/c1")).toBe(false);
  });

  test("a stopped agent never rests, whatever was pressed before", () => {
    const asking = attentionItem("c1", { status: "question", unread: false });
    expect(restAfterNext(asking, undefined, false, T0)).toBeNull();
    expect(isResting(asking, { n: 3, until: new Date(T0 + H).toISOString(), stamp: "x|||||0", at: "" }, T0)).toBe(false);
  });
});

describe("what ends a rest", () => {
  test("its time, or anything new in the chat, which also starts the ladder again; reading the card changes nothing", () => {
    const card = stale();
    const rest = must(restAfterNext(card, undefined, false, T0), "a rest");
    expect(isResting(card, rest, T0 + 5 * MIN)).toBe(true);
    // Opened and read: the card is the same card.
    expect(isResting({ ...card, viewedAt: new Date(T0 + MIN).toISOString() }, rest, T0 + 5 * MIN)).toBe(true);
    expect(isResting(card, rest, T0 + 11 * MIN)).toBe(false);
    expect(restState(card, rest, T0 + 11 * MIN)).toEqual({ resting: false, rung: 1, rested: true });
    // The agent says something new (or the person sent something, which starts a turn): the rest is over, the rung 0.
    const moved = { ...card, lastAssistantText: "done", turns: 1 };
    expect(isResting(moved, rest, T0 + 5 * MIN)).toBe(false);
    expect(restState(moved, rest, T0 + 5 * MIN)).toEqual({ resting: false, rung: 0, rested: false });
    expect(must(restAfterNext({ ...moved, unread: false }, rest, false, T0), "a rest").n).toBe(1);
  });

  test("an undo brings the card back now, on the rung it had", () => {
    const before: Rest = { n: 2, until: "", stamp: "s", at: "" };
    const undone = restUndone(before, T0);
    expect(undone).toEqual({ n: 2, until: new Date(T0).toISOString(), stamp: "s", at: new Date(T0).toISOString() });
    expect(restUndone(undefined, T0).n).toBe(0);
  });
});

describe("the Inbox with resting cards", () => {
  const items = [stale("a"), { ...stale("b"), resting: true }, { ...stale("c"), resting: true, status: "running" as const }];

  test("leaves them out and counts them; going through them lets them in", () => {
    expect(inboxQueue(items).map((i) => i.id)).toEqual(["a"]);
    expect(restingCount(items)).toBe(1);
    expect(inboxQueue(items, true).map((i) => i.id)).toEqual(["a", "b"]);
  });

  test("on the phone, going through them brings back what this visit moved past too, and keeps the tally", () => {
    const passed = commitCard(EMPTY_DECK, items[0], "seen");
    expect(deckQueue(items, passed)).toEqual([]);
    const again = throughResting(passed);
    expect(deckQueue(items, again).map((i) => i.id)).toEqual(["a", "b"]);
    expect(again.pass).toEqual(passed.pass);
  });
});

describe("the mod keeps the rests", () => {
  test("across a restart, the later rest winning; one set over a month ago is dropped when the next is set", () => {
    const dir = mkdtempSync(join(tmpdir(), "loki-rests-"));
    try {
      const path = join(dir, "attention.json");
      let now = "2026-10-20T09:00:00.000Z";
      const store = new SeenStore(path, { debounceMs: 0, now: () => now });
      const old: Rest = { n: 1, until: "2026-09-10T09:10:00.000Z", stamp: "s", at: "2026-09-10T09:00:00.000Z" };
      const rest: Rest = { n: 2, until: "2026-10-20T09:30:00.000Z", stamp: "s", at: now };
      expect(store.rest("a1", "c2", old)).toBe(true);
      expect(store.rest("a1", "c1", rest)).toBe(true);
      expect(store.rest("a1", "c1", { ...rest, n: 1, at: "2026-10-20T08:00:00.000Z" })).toBe(false);
      now = "2026-10-20T09:01:00.000Z";
      store.flush();
      expect(new SeenStore(path).restsAll()).toEqual({ "a1/c1": rest });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
