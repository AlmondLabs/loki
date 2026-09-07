import { describe, expect, test } from "bun:test";
import { createBridge, scopeOfId, sortDesks, type DeskSummary } from "../mod/bridge.ts";
import { DeskStore } from "../mod/desk-store.ts";
import { GestureLog } from "../mod/gestures.ts";
import type { WidgetsWatcher } from "../mod/widgets-fs.ts";
import type { WidgetManifestEntry } from "../packages/core/src/desk-core.ts";
import type { Client } from "../mod/server.ts";

function fakeWidgets(entries: WidgetManifestEntry[]): WidgetsWatcher & { runtime: Map<string, string> } {
  const runtime = new Map<string, string>();
  return {
    runtime,
    entries: (scope) => entries.filter((e) => !scope || e.scope === scope).map((e) => (runtime.has(e.id) ? { ...e, error: runtime.get(e.id) } : e)),
    get: (id) => entries.find((e) => e.id === id),
    setRuntimeError(id, msg) {
      const prev = runtime.get(id) ?? null;
      if (prev === msg) return false;
      if (msg) runtime.set(id, msg);
      else runtime.delete(id);
      return true;
    },
    rescan: async () => {},
    close() {},
  };
}

const sleep: WidgetManifestEntry = {
  id: "c1/sleep", scope: "c1", name: "sleep", kind: "json", file: "c1/sleep.json", title: "Sleep", type: "slider-control",
  data: { value: 6 }, hash: "h", updatedAt: 0,
};
const welcome: WidgetManifestEntry = { ...sleep, id: "shared/welcome", scope: "shared", name: "welcome", file: "shared/welcome.json", title: "loki", type: "info-card", data: { lines: [] } };

function client(scope: string): Client & { sent: Array<Record<string, unknown>> } {
  const sent: Array<Record<string, unknown>> = [];
  return { scope, sent, send: (m) => sent.push(m as Record<string, unknown>) };
}

describe("bridge", () => {
  test("scopeOfId", () => {
    expect(scopeOfId("c1/sleep")).toBe("c1");
    expect(scopeOfId("nope")).toBe("shared");
  });

  test("connect sends own desk then shared", () => {
    const store = new DeskStore();
    const broadcasts: unknown[] = [];
    const bridge = createBridge({ store, widgets: fakeWidgets([sleep, welcome]), gestures: new GestureLog(), broadcast: (m) => broadcasts.push(m) });
    const c = client("c1");
    bridge.onConnect(c);
    expect(c.sent.map((m) => [m.type, m.scope])).toEqual([["config", undefined], ["desk", "c1"], ["desk", "shared"]]);
    expect((c.sent[1].widgets as unknown[]).length).toBe(1);
    const s = client("shared");
    bridge.onConnect(s);
    expect(s.sent.map((m) => m.type)).toEqual(["config", "desk"]);
  });

  test("gesture updates the widget's desk and logs under the client's desk with before-value", () => {
    const store = new DeskStore();
    const gestures = new GestureLog();
    const bridge = createBridge({ store, widgets: fakeWidgets([sleep, welcome]), gestures, broadcast: () => {} });
    const c = client("c1");
    bridge.onMessage(c, { type: "gesture", gesture: { kind: "set", id: "c1/sleep", path: "value", value: 7 } });
    bridge.onMessage(c, { type: "gesture", gesture: { kind: "move", id: "shared/welcome", position: { x: 3, y: 4 } } });
    bridge.onMessage(c, { type: "gesture", gesture: { kind: "focus", id: "shared/welcome" } });
    expect(store.get("c1").overlay["c1/sleep"]).toEqual({ value: 7 });
    expect(store.get("shared").layout["shared/welcome"].position).toEqual({ x: 3, y: 4 });
    expect(gestures.peek("c1")).toEqual(['set value = 7 (was 6) on "Sleep" (c1/sleep)', 'moved "loki" (shared/welcome) to (3, 4)']);
    bridge.onMessage(c, { type: "gesture", gesture: { kind: "move", id: "c1/sleep" } });
    expect(c.sent.at(-1)).toEqual({ type: "error", message: "malformed gesture" });
  });

  test("widget_status broadcasts the manifest and logs errors once", () => {
    const store = new DeskStore();
    const gestures = new GestureLog();
    const broadcasts: Array<[Record<string, unknown>, string | undefined]> = [];
    const widgets = fakeWidgets([sleep]);
    const bridge = createBridge({ store, widgets, gestures, broadcast: (m, s) => broadcasts.push([m as Record<string, unknown>, s]) });
    const c = client("c1");
    bridge.onMessage(c, { type: "widget_status", id: "c1/sleep", error: "boom" });
    bridge.onMessage(c, { type: "widget_status", id: "c1/sleep", error: "boom" });
    expect(broadcasts.length).toBe(1);
    expect(broadcasts[0][0].type).toBe("widgets");
    expect(broadcasts[0][1]).toBe("c1");
    expect(gestures.peek("c1")).toEqual(['widget "Sleep" (c1/sleep) failed to render: boom']);
    bridge.onMessage(c, { type: "widget_status", id: "c1/sleep", error: null });
    expect(widgets.runtime.size).toBe(0);
  });


  test("desk frames carry the conversation title and status", async () => {
    const bridge = createBridge({
      store: new DeskStore(), widgets: fakeWidgets([sleep]), gestures: new GestureLog(), broadcast: () => {},
      deskInfo: (s) => (s === "c1" ? { title: "[Short] - Sleep tracking", status: "archived", agentName: "ira", agentId: "a1", model: "anthropic/claude-fable-5" } : s === "gone" ? { title: null, status: "deleted", agentName: null, agentId: null, model: null } : { title: "shared", status: "none", agentName: null, agentId: null, model: null }),
    });
    const c = client("c1");
    bridge.onConnect(c);
    expect(c.sent[0]).toMatchObject({ type: "config" });
    expect(c.sent[1]).toMatchObject({ type: "desk", scope: "c1", title: "[Short] - Sleep tracking", status: "archived", agentName: "ira" });
    expect(c.sent[2]).toMatchObject({ type: "desk", scope: "shared", title: "shared", status: "none" });
    bridge.onConnect(client("gone"));
    await new Promise((r) => setTimeout(r, 10));
  });

  test("sortDesks: shared, then live (pinned, active, then recent), then archived, then deleted", () => {
    const d = (scope: string, status: DeskSummary["status"], extra: Partial<DeskSummary> = {}): DeskSummary => ({ scope, status, title: null, agentName: null, agentId: null, conversationId: null, model: null, widgets: 0, active: false, lastActive: null, ...extra });
    const sorted = sortDesks([
      d("old", "live", { lastActive: "2026-09-01T00:00:00Z" }),
      d("gone", "deleted"),
      d("arch", "archived", { lastActive: "2026-09-03T00:00:00Z" }),
      d("shared", "none"),
      d("now", "live", { active: true, lastActive: "2026-08-01T00:00:00Z" }),
      d("new", "live", { lastActive: "2026-09-02T00:00:00Z" }),
      d("pinned", "live", { pinned: true, lastActive: "2026-07-01T00:00:00Z" }),
    ]).map((x) => x.scope);
    expect(sorted).toEqual(["shared", "pinned", "now", "new", "old", "arch", "gone"]);
  });

  test("list_desks replies with the mod's desk list", () => {
    const desks: DeskSummary[] = [{ scope: "shared", title: "shared", status: "none", agentName: null, agentId: null, conversationId: null, model: null, widgets: 1, active: false, lastActive: null }];
    const bridge = createBridge({ store: new DeskStore(), widgets: fakeWidgets([]), gestures: new GestureLog(), broadcast: () => {}, listDesks: () => desks });
    const c = client("c1");
    bridge.onMessage(c, { type: "list_desks" });
    expect(c.sent[0]).toEqual({ type: "desks", desks });
  });

  test("measure records size; arrange tidies, logs, and glides to fit", () => {
    const store = new DeskStore();
    store.seen("c1", "c1/a");
    store.gesture("c1", { kind: "move", id: "c1/b", position: { x: 125, y: 125 } });
    const gestures = new GestureLog();
    const broadcasts: Array<[Record<string, unknown>, string | undefined]> = [];
    const bridge = createBridge({ store, widgets: fakeWidgets([]), gestures, broadcast: (m, s) => broadcasts.push([m as Record<string, unknown>, s]) });
    const c = client("c1");
    bridge.onMessage(c, { type: "measure", id: "c1/a", size: { w: 280, h: 240 } });
    expect(store.get("c1").layout["c1/a"].size).toEqual({ w: 280, h: 240 });
    bridge.onMessage(c, { type: "measure", id: "c1/a", size: { w: "x" } }); // ignored
    bridge.onMessage(c, { type: "arrange" });
    const a = store.get("c1").layout["c1/a"].position;
    const b = store.get("c1").layout["c1/b"].position;
    expect(a).not.toEqual(b);
    expect(gestures.peek("c1")).toEqual(["tidied the desk (auto-arranged 2 widgets)"]);
    expect(broadcasts.at(-1)?.[0]).toMatchObject({ type: "camera", widgetIds: expect.arrayContaining(["c1/a", "c1/b"]) });
  });

  test("trash deletes the file through the mod, forgets the layout, and tells the agent", () => {
    const store = new DeskStore();
    store.seen("c1", "c1/sleep");
    const gestures = new GestureLog();
    const deleted: string[] = [];
    const bridge = createBridge({ store, widgets: fakeWidgets([sleep]), gestures, broadcast: () => {}, deleteWidgetFile: (id) => (deleted.push(id), `/w/${id}.json`) });
    const c = client("c1");
    bridge.onMessage(c, { type: "trash", id: "c1/sleep" });
    expect(deleted).toEqual(["c1/sleep"]);
    expect(store.get("c1").layout["c1/sleep"]).toBeUndefined();
    expect(gestures.peek("c1")).toEqual(['trashed "Sleep" (c1/sleep) — its file was deleted']);
    const failing = createBridge({ store, widgets: fakeWidgets([sleep]), gestures: new GestureLog(), broadcast: () => {}, deleteWidgetFile: () => null });
    const c2 = client("c1");
    failing.onMessage(c2, { type: "trash", id: "c1/sleep" });
    expect(c2.sent[0]).toMatchObject({ type: "error" });
  });

  test("unknown message types get an error frame", () => {
    const bridge = createBridge({ store: new DeskStore(), widgets: fakeWidgets([]), gestures: new GestureLog(), broadcast: () => {} });
    const c = client("c1");
    bridge.onMessage(c, { type: "wat" });
    expect(c.sent[0]).toEqual({ type: "error", message: "unsupported message type: wat" });
  });
});

describe("bridge history", () => {
  test("history_get answers with the local transcript and echoes the request id", () => {
    const bridge = createBridge({
      store: new DeskStore(), widgets: fakeWidgets([sleep]), gestures: new GestureLog(), broadcast: () => {},
      transcript: (agentId, conversationId) => (agentId === "a1" && conversationId === "c9" ? [{ role: "user", text: "hi" }, { role: "tool", text: "Bash · ls" }] : []),
    });
    const c = client("c1");
    bridge.onConnect(c);
    bridge.onMessage(c, { type: "history_get", requestId: "h1", agentId: "a1", conversationId: "c9" });
    const reply = c.sent.find((m) => m.type === "history")!;
    expect(reply).toMatchObject({ requestId: "h1", agentId: "a1", conversationId: "c9" });
    expect((reply.messages as unknown[]).length).toBe(2);
    bridge.onMessage(c, { type: "history_get", requestId: "h2", agentId: "a1", conversationId: "unknown" });
    expect(c.sent.filter((m) => m.type === "history").at(-1)).toMatchObject({ requestId: "h2", messages: [] });
  });
});
