import { describe, expect, test } from "bun:test";
import type { WidgetLogEntry } from "../core/desk-core.ts";
import type { TranscriptRow } from "../core/attention/transcript.ts";
import { parseWidgetEntry, widgetMarks, withEntry, withHistoryLog } from "../app/src/desk/widgetRows.ts";

/**
 * Widget rows in the thread (plan 013 U8, R15, AE2): the desk's widget change log merged among the
 * messages by time, live entries kept per desk and replaced by id, and a removed widget's row that says
 * it is gone instead of framing anything.
 */

const T0 = Date.parse("2026-09-23T10:00:00.000Z");
const iso = (min: number) => new Date(T0 + min * 60_000).toISOString();
const entry = (over: Partial<WidgetLogEntry> = {}): WidgetLogEntry => ({
  id: "e1",
  at: T0 + 5 * 60_000,
  scope: "desk-a",
  widgetId: "desk-a/revenue",
  name: "revenue",
  title: "Revenue chart",
  kind: "json",
  change: "added",
  ...over,
});
const row = (role: TranscriptRow["role"], min?: number): TranscriptRow => ({ role, text: role, ...(min === undefined ? {} : { at: iso(min) }) });

describe("widget rows: merge by time", () => {
  test("an entry sits before the first message after it", () => {
    const rows = [row("user", 0), row("assistant", 1), row("user", 10)];
    const [m] = widgetMarks(rows, [entry()], "friday");
    expect(m.before).toBe(2);
    expect(m.agent).toBe("friday");
    expect(m.change).toBe("added");
    expect(m.title).toBe("Revenue chart");
    expect(m.at).toBe(iso(5));
  });
  test("an entry after every message goes after the latest one (AE2)", () => {
    const rows = [row("user", 0), row("assistant", 1)];
    expect(widgetMarks(rows, [entry()], "friday")[0].before).toBe(2);
  });
  test("an entry older than every message goes first", () => {
    const rows = [row("user", 10), row("assistant", 11)];
    expect(widgetMarks(rows, [entry()], "friday")[0].before).toBe(0);
  });
  test("rows without a time keep arrival order: only timed rows place an entry", () => {
    const rows = [row("user", 0), row("assistant"), row("tool"), row("user", 10)];
    expect(widgetMarks(rows, [entry()], "friday")[0].before).toBe(3);
    // a thread with no times at all: the entries follow it
    expect(widgetMarks([row("user"), row("assistant")], [entry()], "friday")[0].before).toBe(2);
  });
  test("several entries interleave in time order, ties by log order", () => {
    const rows = [row("user", 0), row("assistant", 6), row("user", 20)];
    const log = [entry({ id: "b", at: T0 + 15 * 60_000 }), entry({ id: "a", at: T0 + 2 * 60_000 }), entry({ id: "c", at: T0 + 15 * 60_000 })];
    expect(widgetMarks(rows, log, "friday").map((m) => [m.id, m.before])).toEqual([
      ["a", 1],
      ["b", 2],
      ["c", 2],
    ]);
  });
  test("no log, no marks; an empty thread still shows the log", () => {
    expect(widgetMarks([row("user", 0)], undefined, "friday")).toEqual([]);
    expect(widgetMarks([], [entry()], "friday")[0].before).toBe(0);
  });
  test("the agent falls back to a plain word", () => {
    expect(widgetMarks([], [entry()], null)[0].agent).toBe("the agent");
  });
});

describe("widget rows: gone widgets", () => {
  test("a removed row is gone and does not frame", () => {
    const [m] = widgetMarks([], [entry({ change: "removed" })], "friday");
    expect(m.gone).toBe(true);
  });
  test("an earlier row for a widget removed since is gone too; one re-added after is not", () => {
    const log = [entry({ id: "a", at: T0 }), entry({ id: "b", at: T0 + 1, change: "removed" })];
    expect(widgetMarks([], log, "friday").map((m) => m.gone)).toEqual([true, true]);
    const back = [...log, entry({ id: "c", at: T0 + 2 })];
    expect(widgetMarks([], back, "friday").map((m) => m.gone)).toEqual([false, true, false]);
  });
  test("an added or changed row for a widget still there frames it", () => {
    const log = [entry({ id: "a" }), entry({ id: "b", at: T0 + 9 * 60_000, change: "changed" })];
    expect(widgetMarks([], log, "friday").map((m) => m.gone)).toEqual([false, false]);
  });
});

describe("widget rows: the per-desk store", () => {
  test("a live entry lands under its own desk, for when that desk next opens", () => {
    const s = withEntry({}, entry({ scope: "desk-b", widgetId: "desk-b/sleep" }));
    expect(Object.keys(s)).toEqual(["desk-b"]);
    expect(s["desk-b"].map((e) => e.id)).toEqual(["e1"]);
  });
  test("a collapsed repeat edit replaces its row by id, moved to its later time", () => {
    let s = withEntry({}, entry({ id: "a", at: T0, change: "changed" }));
    s = withEntry(s, entry({ id: "b", at: T0 + 1000 }));
    s = withEntry(s, entry({ id: "a", at: T0 + 2000, change: "changed" }));
    expect(s["desk-a"].map((e) => [e.id, e.at])).toEqual([
      ["b", T0 + 1000],
      ["a", T0 + 2000],
    ]);
  });
  test("the same entry twice leaves the store as it was", () => {
    const s = withEntry({}, entry());
    expect(withEntry(s, entry())).toBe(s);
  });
  test("history merges with what arrived live: by id, the later time wins", () => {
    let s = withEntry({}, entry({ id: "live", at: T0 + 9000 }));
    s = withEntry(s, entry({ id: "a", at: T0 + 5000, change: "changed" }));
    s = withHistoryLog(s, "desk-a", [entry({ id: "old", at: T0 }), entry({ id: "a", at: T0 + 1000, change: "changed" })]);
    expect(s["desk-a"].map((e) => [e.id, e.at])).toEqual([
      ["old", T0],
      ["a", T0 + 5000],
      ["live", T0 + 9000],
    ]);
  });
  test("history for one desk leaves the others alone; garbage is dropped", () => {
    const s = withEntry({}, entry({ scope: "desk-b", widgetId: "desk-b/x" }));
    const next = withHistoryLog(s, "desk-a", [entry(), { nope: true } as unknown as WidgetLogEntry]);
    expect(next["desk-b"]).toBe(s["desk-b"]);
    expect(next["desk-a"].map((e) => e.id)).toEqual(["e1"]);
  });
});

describe("widget rows: the widget_change frame", () => {
  test("parses a well-formed entry", () => {
    expect(parseWidgetEntry(entry())).toEqual(entry());
  });
  test("drops anything else", () => {
    expect(parseWidgetEntry(null)).toBeNull();
    expect(parseWidgetEntry({ ...entry(), at: "soon" })).toBeNull();
    expect(parseWidgetEntry({ ...entry(), change: "moved" })).toBeNull();
    expect(parseWidgetEntry({ ...entry(), scope: undefined })).toBeNull();
  });
});

describe("widget rows: runs", () => {
  test("a widget row between two messages by the same author starts a new run", async () => {
    const { runStarts } = await import("../app/src/chat/Transcript.tsx");
    const rows = [row("assistant", 0), row("assistant", 1), row("assistant", 2)];
    expect(runStarts(rows)).toEqual([true, false, false]);
    expect(runStarts(rows, null, null, new Map([[2, []]]))).toEqual([true, false, true]);
  });
});
