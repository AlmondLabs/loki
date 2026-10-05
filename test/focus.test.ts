import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FOCUS_CUSHION, FOCUS_OPEN_GAP_MS, SKIP_FACTOR, addFocus, decayed, focusShares, pruneFocus, type FocusEntry } from "../core/attention/focus.ts";
import { SeenStore } from "../mod/seen.ts";
import { skipsFocus } from "../core/attention/useAttention.ts";

/** Focus (core/attention/focus.ts): each chat's share of what you have been doing lately, fading by half every 12 hours. */

const H = 3_600_000;
const T0 = new Date("2026-09-20T09:00:00Z").getTime();
/** One chat's entry after the given actions, `hours` after T0 each. */
function run(actions: Array<[number, "message" | "answer" | "decide" | "open"]>): FocusEntry {
  let e: FocusEntry | undefined;
  for (const [h, a] of actions) e = addFocus(e, a, T0 + h * H) ?? e;
  return e!;
}

describe("focus weights", () => {
  test("an action adds its weight; the weight halves every 12 hours", () => {
    const e = run([[0, "message"]]);
    expect(e.w).toBe(1);
    expect(decayed(e, T0 + 12 * H)).toBeCloseTo(0.5, 5);
    expect(decayed(e, T0 + 36 * H)).toBeCloseTo(0.125, 5);
    expect(run([[0, "decide"]]).w).toBe(0.5);
    expect(run([[0, "open"]]).w).toBe(0.25);
  });

  test("opening the same chat again within half an hour adds nothing", () => {
    const e = run([[0, "open"]]);
    expect(addFocus(e, "open", T0 + FOCUS_OPEN_GAP_MS - 1)).toBeNull();
    expect(addFocus(e, "open", T0 + FOCUS_OPEN_GAP_MS)!.w).toBeGreaterThan(0.25);
    // a message is never throttled
    expect(addFocus(e, "message", T0 + 60_000)!.w).toBeCloseTo(1.25, 2);
  });

  test("the share is the chat's weight over everyone's plus the cushion", () => {
    const shares = focusShares({ a: { w: 3, t: new Date(T0).toISOString() }, b: { w: 1, t: new Date(T0).toISOString() } }, T0);
    expect(shares.a).toBeCloseTo(3 / (4 + FOCUS_CUSHION), 5);
    expect(shares.b).toBeCloseTo(1 / (4 + FOCUS_CUSHION), 5);
    expect(focusShares({}, T0)).toEqual({});
  });

  test("parking: a new task overtakes yesterday's within a handful of replies, and a parked chat fades in days", () => {
    // A: 20 replies yesterday 09:00–17:00; B: the new task from 10:00 today, a reply every quarter hour
    const a = run(Array.from({ length: 20 }, (_, i) => [i * 0.4, "message"] as [number, "message"]));
    const bAfter = (n: number) => run(Array.from({ length: n }, (_, i) => [25 + i * 0.25, "message"] as [number, "message"]));
    const at = (n: number) => T0 + (25 + (n - 1) * 0.25) * H + 1;
    const before = focusShares({ a }, T0 + 25 * H);
    expect(before.a).toBeGreaterThan(0.6);
    const ten = focusShares({ a, b: bAfter(10) }, at(10));
    expect(ten.b).toBeGreaterThan(ten.a);
    const later = focusShares({ a, b: bAfter(10) }, T0 + (25 + 72) * H);
    expect(later.a).toBeLessThan(0.05);
  });

  test("after a quiet week every share falls toward 0, not one chat taking the list", () => {
    const shares = focusShares({ only: run([[0, "message"], [0.5, "message"]]) }, T0 + 7 * 24 * H);
    expect(shares.only).toBeLessThan(0.01);
  });

  test("prune drops chats faded to nothing", () => {
    const kept = pruneFocus({ old: run([[0, "message"]]), fresh: run([[24 * 14, "message"]]) }, T0 + 24 * 14 * H);
    expect(Object.keys(kept)).toEqual(["fresh"]);
  });
});

describe("a skip", () => {
  test("Next on a focus card halves its chat's weight, from where it had faded to; nothing to halve, nothing written", () => {
    const t0 = Date.parse("2026-09-29T06:00:00Z");
    const worked: FocusEntry = { w: 3, t: new Date(t0).toISOString() };
    const later = t0 + 12 * 3_600_000; // one half-life: 1.5 left
    const skipped = addFocus(worked, "skip", later)!;
    expect(skipped.w).toBeCloseTo(1.5 * SKIP_FACTOR);
    expect(skipped.t).toBe(new Date(later).toISOString());
    expect(addFocus(undefined, "skip", later)).toBeNull();
  });
  test("on 29 September's chat (focus 0.34, nothing new), two skips take it from the top", () => {
    // One chat with most of the weight, another you were also in: shares as in the morning's Inbox.
    const now = Date.parse("2026-09-29T08:37:00Z");
    let top: FocusEntry = { w: 2.2, t: new Date(now).toISOString() };
    const other: FocusEntry = { w: 1.0, t: new Date(now).toISOString() };
    const share = () => focusShares({ top, other }, now).top;
    expect(share()).toBeCloseTo(2.2 / (3.2 + FOCUS_CUSHION));
    top = addFocus(top, "skip", now)!;
    top = addFocus(top, "skip", now)!;
    expect(share()).toBeLessThan(focusShares({ top, other }, now).other);
  });
});

describe("which Next is a skip", () => {
  test("only a Next on a focus card, and not straight after acting on it", () => {
    expect(skipsFocus(null, "a", "next", "focus")).toBe(true);
    expect(skipsFocus({ id: "b", action: "reply" }, "a", "next", "focus")).toBe(true);
    expect(skipsFocus({ id: "a", action: "next" }, "a", "next", "focus")).toBe(true); // came round again and skipped again
    expect(skipsFocus({ id: "a", action: "reply" }, "a", "next", "focus")).toBe(false); // moving on after replying
    expect(skipsFocus(null, "a", "next", "new")).toBe(false);
    expect(skipsFocus(null, "a", "archive", "focus")).toBe(false);
  });
});

describe("the mod's focus store", () => {
  test("engage adds, persists and survives a reload; a repeat open inside the gap is not a change", () => {
    const dir = mkdtempSync(join(tmpdir(), "loki-focus-"));
    const path = join(dir, "attention.json");
    let now = T0;
    const store = new SeenStore(path, { debounceMs: 0, now: () => new Date(now).toISOString() });
    expect(store.engage("ag", "c1", "message")).toBe(true);
    expect(store.engage("ag", "c1", "open")).toBe(false);
    now += FOCUS_OPEN_GAP_MS;
    expect(store.engage("ag", "c1", "open")).toBe(true);
    store.flush();
    expect(Object.keys(store.focusAll())).toEqual(["ag/c1"]);
    const reread = new SeenStore(path);
    expect(reread.focusAll()["ag/c1"].w).toBeGreaterThan(1.2);
    expect(JSON.parse(readFileSync(path, "utf8")).focus["ag/c1"]).toBeDefined();
  });
});
