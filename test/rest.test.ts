import { describe, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SeenStore } from "../mod/seen.ts";
import { inboxQueue, restingCount } from "../core/attention/queue.ts";
import {
  REST_CAP_MS,
  REST_FIRST_CHOICES,
  REST_FIRST_MS,
  REST_LATER_CHOICES,
  RETURN_TIMES_DEFAULT,
  cardKindOf,
  isRest,
  isResting,
  outsideResting,
  isReturnTimes,
  laterMs,
  readFirstMs,
  restAfterLater,
  movesOn,
  parseRestFirst,
  restAfterNext,
  restState,
  restUndone,
  rungMs,
  type Rest,
} from "../core/attention/rest.ts";
import { EMPTY_DECK, commitCard, deckQueue, throughResting } from "../app/src/phone/deck.ts";
import { attentionItem } from "./fixtures/attention.ts";
import { must } from "./fixtures/must.ts";
import { outsideItem } from "./fixtures/outside-item.ts";
import { moveRestFirst } from "../app/src/shared/rest-first.ts";

/** Rest (core/attention/rest.ts, plans 026 and 065): Next on a card hides it, a stale one longer each time, until something new comes. */

const MIN = 60_000;
const H = 60 * MIN;
const T0 = Date.parse("2026-10-20T09:00:00Z");
/** A card with nothing new, its chat quiet for `quiet` ms at T0. */
const stale = (id = "c1", quiet = 0) => attentionItem(id, { unread: false, status: "idle", last_message_at: new Date(T0 - quiet).toISOString() });
const gap = (r: Rest | null, at = T0) => Date.parse(must(r, "a rest").until) - at;
const DAY = 24 * H;

describe("the ladder", () => {
  test("each Next in a row on a stale card rests it three times longer from an hour, up to a week", () => {
    expect(REST_FIRST_MS).toBe(H);
    expect([1, 2, 3, 4, 5, 6].map((n) => rungMs(n) / H)).toEqual([1, 3, 9, 27, 81, 168]);
    expect(rungMs(20)).toBe(REST_CAP_MS);
    let rest: Rest | null = null;
    const gaps: number[] = [];
    for (let i = 0; i < 3; i++) {
      rest = restAfterNext(stale(), rest ?? undefined, false, T0);
      gaps.push(gap(rest) / H);
    }
    expect(gaps).toEqual([1, 3, 9]);
    expect(must(rest, "a rest").n).toBe(3);
  });

  test("the first rung is the person's setting, and the ladder climbs from it", () => {
    const first = REST_FIRST_CHOICES["10m"];
    expect([1, 2, 3].map((n) => rungMs(n, first) / MIN)).toEqual([10, 30, 90]);
    const once = restAfterNext(stale(), undefined, false, T0, first);
    expect(gap(once) / MIN).toBe(10);
    expect(gap(restAfterNext(stale(), must(once, "a rest"), false, T0, first)) / MIN).toBe(30);
  });

  test("a stored choice reads as itself; nothing or anything unknown reads as an hour", () => {
    expect(parseRestFirst("3h")).toBe("3h");
    expect(parseRestFirst(null)).toBe("1h");
    expect(parseRestFirst("5m")).toBe("1h");
    expect(parseRestFirst("toString")).toBe("1h");
  });

  test("a chat quiet for two days rests two days more; one quiet a month, a week", () => {
    expect(gap(restAfterNext(stale("c1", 48 * H), undefined, false, T0))).toBe(48 * H);
    expect(gap(restAfterNext(stale("c1", 30 * 24 * H), undefined, false, T0))).toBe(REST_CAP_MS);
  });

  test("a card with something new, or a Next straight after replying, rests the first rung and does not climb", () => {
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

describe("later (plan 070, U4)", () => {
  const later = (item = stale(), prev?: Rest, at = T0) => must(restAfterLater(item, prev, at, laterMs(RETURN_TIMES_DEFAULT, cardKindOf(item))), "a later rest");

  test("a later press rests a day; the second on the same stamp asks when; a new message in between makes it a first press again", () => {
    const once = later();
    expect([gap(once.rest), once.rest.kind, once.rest.n, once.ask]).toEqual([DAY, "later", 1, false]);
    const twice = later(stale(), once.rest, T0 + DAY);
    expect([twice.rest.n, twice.ask]).toEqual([2, true]);
    const moved = { ...stale(), lastAssistantText: "something new" };
    const fresh = later(moved, once.rest, T0 + DAY);
    expect([fresh.rest.n, fresh.ask]).toEqual([1, false]);
  });

  test("a read rest between two later presses starts the later count over", () => {
    const once = later();
    const read = must(restAfterNext(stale(), once.rest, false, T0 + DAY), "a read rest");
    expect(read.kind).toBe("read");
    const again = later(stale(), read, T0 + 2 * DAY);
    expect([again.rest.n, again.ask]).toEqual([1, false]);
  });

  test("a stopped agent is never put off", () => {
    expect(restAfterLater(attentionItem("c1", { status: "approval" }), undefined, T0, DAY)).toBeNull();
  });

  test("each kind of card keeps its own return times, and an unknown record is not one", () => {
    const mail = outsideItem("Quarterly numbers");
    const slack = outsideItem("hi", { outside: { ...must(mail.outside, "facts"), provider: "slack" } });
    const jira = outsideItem("OPS-7", { outside: { ...must(mail.outside, "facts"), provider: "jira" } });
    expect([cardKindOf(stale()), cardKindOf(mail), cardKindOf(slack), cardKindOf(jira)]).toEqual(["chat", "email", "slack", "slack"]);
    expect(readFirstMs(RETURN_TIMES_DEFAULT, "email")).toBe(H);
    expect(laterMs(RETURN_TIMES_DEFAULT, "slack")).toBe(DAY);
    expect(isReturnTimes(RETURN_TIMES_DEFAULT)).toBe(true);
    expect(isReturnTimes({ ...RETURN_TIMES_DEFAULT, later: { chat: "1d", email: "5d", slack: "1d" } })).toBe(false);
    expect(isReturnTimes(null)).toBe(false);
  });

  test("setting email's later return to two days changes the next press only; a card already resting keeps its time", () => {
    const mail = outsideItem("Quarterly numbers");
    const before = must(restAfterLater(mail, undefined, T0, laterMs(RETURN_TIMES_DEFAULT, "email")), "a later rest").rest;
    const times = { ...RETURN_TIMES_DEFAULT, later: { ...RETURN_TIMES_DEFAULT.later, email: "2d" as const } };
    expect(laterMs(times, "email")).toBe(REST_LATER_CHOICES["2d"]);
    expect(laterMs(times, "chat")).toBe(DAY);
    // The stored rest is an absolute time: it ends a day after the press, whatever the setting says now.
    expect(isResting(mail, before, T0 + DAY + MIN)).toBe(false);
    const next = must(
      restAfterLater({ ...mail, outside: { ...must(mail.outside, "facts"), newest_message_id: "m2" } }, before, T0, laterMs(times, "email")),
      "a rest",
    ).rest;
    expect(gap(next)).toBe(2 * DAY);
  });

  test("a rest from an older Mac, with no kind, stays valid; an older Mac reads a later rest by the fields it knows", () => {
    const rest = later().rest;
    expect(isRest(rest)).toBe(true);
    const { kind: _, ...old } = rest;
    expect(isRest(old)).toBe(true);
    expect(isRest({ ...rest, kind: "snooze" })).toBe(false);
    // What an older Mac checks: n, until, stamp and at, each of its own type.
    expect([typeof rest.n, typeof rest.until, typeof rest.stamp, typeof rest.at]).toEqual(["number", "string", "string", "string"]);
  });
});

describe("read rests on an outside card (KTD10)", () => {
  test("a week-old read email rests an hour, not a week; the next read rest on its return rests longer", () => {
    const old = outsideItem("Newsletter", { unread: false, last_message_at: new Date(T0 - 7 * DAY).toISOString() });
    const first = must(restAfterNext(old, undefined, false, T0, readFirstMs(RETURN_TIMES_DEFAULT, "email")), "a rest");
    expect([gap(first), first.kind]).toEqual([H, "read"]);
    const second = restAfterNext(old, first, false, T0 + H, readFirstMs(RETURN_TIMES_DEFAULT, "email"));
    expect(gap(second, T0 + H)).toBe(3 * H);
  });

  test("a chat still rests by today's ladder, quiet time included", () => {
    expect(gap(restAfterNext(stale("c1", 7 * DAY), undefined, false, T0))).toBe(REST_CAP_MS);
    expect(gap(restAfterNext(stale("c1", 5 * H), undefined, false, T0))).toBe(5 * H);
  });
});

describe("the first rest moves to the daemon", () => {
  /** A storage holding what the test puts in it. */
  const storage = (init: Record<string, string>) => {
    const data = new Map(Object.entries(init));
    return {
      data,
      getItem: (k: string) => data.get(k) ?? null,
      removeItem: (k: string) => void data.delete(k),
    };
  };

  test("the old setting's value becomes the chat and email read rest, once, and leaves this device", () => {
    const local = storage({ "loki.restFirst": "3h" });
    const sent: unknown[] = [];
    expect(moveRestFirst(null, (t) => sent.push(t) > 0, local)).toBe(true);
    expect(sent).toEqual([{ ...RETURN_TIMES_DEFAULT, read_first: { chat: "3h", email: "3h" } }]);
    expect(local.data.has("loki.restFirst")).toBe(false);
    expect(moveRestFirst(null, (t) => sent.push(t) > 0, local)).toBe(false);
  });

  test("nothing moves while the daemon has its own, or before it has said, or when nothing was set here", () => {
    const sent: unknown[] = [];
    const local = storage({ "loki.restFirst": "3h" });
    expect(moveRestFirst(RETURN_TIMES_DEFAULT, (t) => sent.push(t) > 0, local)).toBe(false);
    expect(moveRestFirst(undefined, (t) => sent.push(t) > 0, local)).toBe(false);
    expect(local.data.has("loki.restFirst")).toBe(true);
    expect(moveRestFirst(null, (t) => sent.push(t) > 0, storage({}))).toBe(false);
    expect(sent).toEqual([]);
    // A send that did not go keeps the choice here for the next push.
    expect(moveRestFirst(null, () => false, local)).toBe(false);
    expect(local.data.has("loki.restFirst")).toBe(true);
  });
});

describe("what ends a rest", () => {
  test("its time, or anything new in the chat, which also starts the ladder again; reading the card changes nothing", () => {
    const card = stale();
    const rest = must(restAfterNext(card, undefined, false, T0), "a rest");
    expect(isResting(card, rest, T0 + 50 * MIN)).toBe(true);
    // Opened and read: the card is the same card.
    expect(isResting({ ...card, viewedAt: new Date(T0 + MIN).toISOString() }, rest, T0 + 50 * MIN)).toBe(true);
    expect(isResting(card, rest, T0 + 61 * MIN)).toBe(false);
    expect(restState(card, rest, T0 + 61 * MIN)).toEqual({ resting: false, rung: 1, rested: true });
    // The agent says something new (or the person sent something, which starts a turn): the rest is over, the rung 0.
    const moved = { ...card, lastAssistantText: "done" };
    expect(isResting(moved, rest, T0 + 5 * MIN)).toBe(false);
    expect(restState(moved, rest, T0 + 5 * MIN)).toEqual({ resting: false, rung: 0, rested: false });
    expect(must(restAfterNext({ ...moved, unread: false }, rest, false, T0), "a rest").n).toBe(1);
  });

  test("an undo brings the card back now, on the rung it had", () => {
    const before: Rest = { n: 2, until: "", stamp: "s", at: "" };
    const undone = restUndone(before, T0);
    expect(undone).toEqual({ n: 2, until: new Date(T0).toISOString(), stamp: "s", at: new Date(T0).toISOString() });
    const later: Rest = { ...before, kind: "later" };
    expect(restUndone(later, T0).kind).toBe("later");
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

  test("a later rest picked three weeks out outlives the month the store forgets rests by", () => {
    const dir = mkdtempSync(join(tmpdir(), "loki-rests-"));
    try {
      let now = "2026-10-01T09:00:00.000Z";
      const store = new SeenStore(join(dir, "attention.json"), { debounceMs: 0, now: () => now });
      const far: Rest = { n: 2, until: "2026-11-05T09:00:00.000Z", stamp: "s", at: now, kind: "later" };
      expect(store.rest("a1", "far", far)).toBe(true);
      now = "2026-11-02T09:00:00.000Z"; // over a month since it was set, three days before it ends
      expect(store.rest("a1", "c1", { n: 1, until: "2026-11-02T10:00:00.000Z", stamp: "s", at: now })).toBe(true);
      expect(store.restsAll()["a1/far"]).toEqual(far);
      store.flush();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("an outside card's rest as the mod judges it (plan 078)", () => {
  test("agrees with the Inbox: resting while its rest holds for its newest message, not after it ends or a newer one comes", () => {
    const item = outsideItem("Budget");
    const now = Date.parse("2026-11-09T10:00:00.000Z");
    const rest: Rest = { n: 0, until: "2026-11-09T11:00:00.000Z", stamp: "outside|m1", at: "2026-11-09T09:00:00.000Z", kind: "read" };
    for (const [r, at, newest] of [
      [rest, now, "m1"],
      [rest, Date.parse(rest.until) + 1, "m1"],
      [rest, now, "m2"],
      [undefined, now, "m1"],
    ] as const) {
      const shown = { ...item, outside: { ...must(item.outside, "outside"), newest_message_id: newest } };
      expect(outsideResting(r, newest, at)).toBe(isResting(shown, r, at));
    }
    expect(outsideResting(rest, "m1", now)).toBe(true);
  });

  test("a Jira comment approved after the rest was set ends it, as the Inbox judges it (plan 2026-11-10-1451, U8)", () => {
    const now = Date.parse("2026-11-09T10:00:00.000Z");
    const rest: Rest = { n: 1, until: "2026-11-09T11:00:00.000Z", stamp: "outside|m1", at: "2026-11-09T09:00:00.000Z", kind: "later" };
    const item = outsideItem("Budget");
    for (const at of ["2026-11-09T08:00:00.000Z", "2026-11-09T09:30:00.000Z"]) {
      const seeds = [{ id: "reply-1", text: "Rotating tonight.", at }];
      const shown = { ...item, outside: { ...must(item.outside, "outside"), provider: "jira" as const, seeds } };
      expect(outsideResting(rest, "m1", now, seeds)).toBe(isResting(shown, rest, now));
    }
    expect(outsideResting(rest, "m1", now, [{ id: "reply-1", text: "x", at: "2026-11-09T08:00:00.000Z" }])).toBe(true);
    expect(outsideResting(rest, "m1", now, [{ id: "reply-1", text: "x", at: "2026-11-09T09:30:00.000Z" }])).toBe(false);
  });
});
