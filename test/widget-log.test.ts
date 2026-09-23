import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WidgetLogEntry, WidgetManifestEntry } from "../core/desk-core.ts";
import { WIDGET_LOG_COLLAPSE_MS, WIDGET_LOG_LIMIT, WidgetLog, broadcastWidgetChanges } from "../mod/widget-log.ts";
import { watchWidgets, type WidgetsDiff } from "../mod/widgets-fs.ts";
import { attachWs, startServer } from "../mod/server.ts";

const entry = (scope: string, name: string, title = name): WidgetManifestEntry => ({
  id: `${scope}/${name}`, scope, name, kind: "json", file: `${scope}/${name}.json`, title, type: "stat", data: {}, hash: "h", updatedAt: 0,
});
const diff = (d: Partial<WidgetsDiff>): WidgetsDiff => ({ added: [], changed: [], removed: [], removedEntries: [], initial: false, ...d });

const tmp = () => mkdtempSync(join(tmpdir(), "loki-widget-log-"));

describe("WidgetLog", () => {
  test("added, changed and removed entries carry time, desk, widget, name, title and kind", () => {
    const log = new WidgetLog(null);
    const t = 1_000_000;
    log.record(diff({ added: [entry("d1", "trip", "Trip")] }), t);
    log.record(diff({ changed: [entry("d1", "trip", "Trip v2")] }), t + WIDGET_LOG_COLLAPSE_MS + 1);
    log.record(diff({ removed: ["d1/trip"], removedEntries: [entry("d1", "trip", "Trip v2")] }), t + 2 * WIDGET_LOG_COLLAPSE_MS + 2);
    const rows = log.read("d1");
    expect(rows.map((r) => [r.change, r.at, r.scope, r.widgetId, r.name, r.title, r.kind])).toEqual([
      ["added", t, "d1", "d1/trip", "trip", "Trip", "json"],
      ["changed", t + WIDGET_LOG_COLLAPSE_MS + 1, "d1", "d1/trip", "trip", "Trip v2", "json"],
      ["removed", t + 2 * WIDGET_LOG_COLLAPSE_MS + 2, "d1", "d1/trip", "trip", "Trip v2", "json"],
    ]);
    expect(new Set(rows.map((r) => r.id)).size).toBe(3);
    expect(log.read("elsewhere")).toEqual([]);
  });

  test("the first scan is the mod starting, not the agent writing: nothing is logged", () => {
    const log = new WidgetLog(null);
    expect(log.record(diff({ added: [entry("d1", "a"), entry("d1", "b")], initial: true }), 1)).toEqual([]);
    expect(log.read("d1")).toEqual([]);
  });

  test("three edits to one widget inside the window collapse into one changed entry, moved to the latest time", () => {
    const log = new WidgetLog(null);
    const t = 5_000_000;
    log.record(diff({ changed: [entry("d1", "trip", "one")] }), t);
    log.record(diff({ added: [entry("d1", "other")] }), t + 1);
    const second = log.record(diff({ changed: [entry("d1", "trip", "two")] }), t + 10_000);
    const third = log.record(diff({ changed: [entry("d1", "trip", "three")] }), t + 20_000);
    const rows = log.read("d1");
    expect(rows.map((r) => [r.widgetId, r.change, r.title, r.at])).toEqual([
      ["d1/other", "added", "other", t + 1],
      ["d1/trip", "changed", "three", t + 20_000],
    ]);
    // The broadcast carries the same entry id, so the app replaces its row instead of adding one.
    expect(second[0].id).toBe(third[0].id);
    expect(third[0].id).toBe(rows[1].id);
  });

  test("an edit right after the widget appeared folds into its added entry", () => {
    const log = new WidgetLog(null);
    log.record(diff({ added: [entry("d1", "trip", "draft")] }), 100);
    log.record(diff({ changed: [entry("d1", "trip", "Trip")] }), 200);
    expect(log.read("d1").map((r) => [r.change, r.title, r.at])).toEqual([["added", "Trip", 200]]);
  });

  test("edits further apart than the window stay separate, and a removal never folds", () => {
    const log = new WidgetLog(null);
    log.record(diff({ changed: [entry("d1", "trip")] }), 0);
    log.record(diff({ changed: [entry("d1", "trip")] }), WIDGET_LOG_COLLAPSE_MS);
    log.record(diff({ removed: ["d1/trip"], removedEntries: [entry("d1", "trip")] }), WIDGET_LOG_COLLAPSE_MS + 1);
    log.record(diff({ changed: [entry("d1", "trip")] }), WIDGET_LOG_COLLAPSE_MS + 2);
    expect(log.read("d1").map((r) => r.change)).toEqual(["changed", "changed", "removed", "changed"]);
  });

  test("the log stays within its bound, dropping the oldest entries", () => {
    const log = new WidgetLog(null);
    for (let i = 0; i < WIDGET_LOG_LIMIT + 5; i++) log.record(diff({ added: [entry("d1", `w${i}`)] }), i);
    const rows = log.read("d1");
    expect(rows.length).toBe(WIDGET_LOG_LIMIT);
    expect(rows[0].name).toBe("w5");
    expect(rows.at(-1)!.name).toBe(`w${WIDGET_LOG_LIMIT + 4}`);
  });

  test("each desk's log persists to its own file and survives a restart; a corrupt file reads as empty", () => {
    const dir = tmp();
    try {
      const a = new WidgetLog(dir);
      a.record(diff({ added: [entry("d1", "trip"), entry("d2", "map")] }), 42);
      expect(existsSync(join(dir, "d1.json"))).toBe(true);
      expect(JSON.parse(readFileSync(join(dir, "d2.json"), "utf8"))).toHaveLength(1);
      const b = new WidgetLog(dir);
      expect(b.read("d1").map((r) => [r.widgetId, r.at])).toEqual([["d1/trip", 42]]);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "d3.json"), "{nope");
      expect(b.read("d3")).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the watcher's first scan is flagged initial; removals carry the entry that went", async () => {
    const root = tmp();
    try {
      mkdirSync(join(root, "d1"));
      writeFileSync(join(root, "d1", "old.json"), '{"type":"stat","title":"Old","data":{}}');
      const diffs: WidgetsDiff[] = [];
      const w = watchWidgets(root, (d) => diffs.push(d), { debounceMs: 20 });
      await w.rescan();
      expect(diffs[0].initial).toBe(true);
      const log = new WidgetLog(null);
      log.record(diffs[0], 1);
      writeFileSync(join(root, "d1", "new.json"), '{"type":"stat","title":"New","data":{}}');
      await w.rescan();
      writeFileSync(join(root, "d1", "new.json"), '{"type":"stat","title":"Newer","data":{}}');
      await w.rescan();
      rmSync(join(root, "d1", "new.json"));
      await w.rescan();
      w.close();
      for (const d of diffs.slice(1)) {
        expect(d.initial).toBe(false);
        log.record(d, 1000);
      }
      expect(diffs.at(-1)!.removedEntries.map((e) => e.title)).toEqual(["Newer"]);
      expect(log.read("d1").map((r) => [r.change, r.title])).toEqual([["added", "Newer"], ["removed", "Newer"]]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("widget_change frames", () => {
  test("every appended or updated entry is broadcast to all sockets (no scope)", () => {
    const log = new WidgetLog(null);
    const sent: Array<[object, string | undefined]> = [];
    broadcastWidgetChanges(log, diff({ added: [entry("d1", "trip")] }), (m, s) => sent.push([m, s]), 7);
    broadcastWidgetChanges(log, diff({ added: [entry("d2", "boot")], initial: true }), (m, s) => sent.push([m, s]), 8);
    expect(sent).toHaveLength(1);
    const [frame, scope] = sent[0] as [{ type: string; entry: WidgetLogEntry }, string | undefined];
    expect(scope).toBeUndefined();
    expect(frame.type).toBe("widget_change");
    expect(frame.entry).toMatchObject({ scope: "d1", widgetId: "d1/trip", change: "added", at: 7 });
  });

  test("a change on desk A reaches a socket connected to desk B", async () => {
    const s = await startServer({ port: 0 });
    const bridge = attachWs(s.server, "tok", { onConnect: (c) => c.send({ type: "hello" }), onMessage: () => {} });
    try {
      const open = (desk: string) =>
        new Promise<WebSocket>((resolve) => {
          const ws = new WebSocket(`ws://127.0.0.1:${s.port}/ws?t=tok&desk=${desk}`);
          ws.onmessage = () => resolve(ws);
        });
      const b = await open("desk_b");
      const got = new Promise<Record<string, unknown>>((resolve) => {
        b.onmessage = (ev) => resolve(JSON.parse(String(ev.data)));
      });
      broadcastWidgetChanges(new WidgetLog(null), diff({ added: [entry("desk_a", "trip")] }), (m, scope) => bridge.broadcast(m, scope), 9);
      expect(await got).toMatchObject({ type: "widget_change", entry: { scope: "desk_a", widgetId: "desk_a/trip" } });
      b.close();
    } finally {
      bridge.close();
      await s.close();
    }
  });
});
