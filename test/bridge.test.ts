import { describe, expect, test } from "bun:test";
import { createBridge, scopeOfId, sortDesks, type DeskSummary, PHONE_FRAMES } from "../mod/bridge.ts";
import { DeskStore } from "../mod/desk-store.ts";
import { GestureLog } from "../mod/gestures.ts";
import type { WidgetsWatcher } from "../mod/widgets-fs.ts";
import type { WidgetManifestEntry } from "../core/desk-core.ts";
import type { Client } from "../mod/server.ts";
import type { LanStatus, LanVia } from "../mod/lan.ts";
import type { TailscaleStatus } from "../mod/tailscale.ts";

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
  test("inbox_list answers with the mod's open conversations and echoes the request id", () => {
    const rows = [{ id: "default", agentId: "a1", agentName: "ira", title: "ira · main chat", lastMessageAt: "2026-09-06T11:49:16Z", archived: false as const, lastRole: "assistant" as const, lastAssistantText: "It's on your canvas now." }];
    const bridge = createBridge({ store: new DeskStore(), widgets: fakeWidgets([]), gestures: new GestureLog(), broadcast: () => {}, listInbox: () => rows });
    const c = client("c1");
    bridge.onMessage(c, { type: "inbox_list", requestId: "i1" });
    expect(c.sent).toEqual([{ type: "inbox", requestId: "i1", conversations: rows }]);
  });
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

describe("bridge: a paired phone's authority", () => {
  test("a device client gets the inbox frames and nothing else", () => {
    const broadcasts: Record<string, unknown>[] = [];
    let forgot: string | null = null;
    const st: LanStatus = { enabled: true, address: "192.168.1.3", addresses: ["192.168.1.3"], host: null, port: 41415, appServed: true, error: null, via: "lan", tailscale: null };
    const lan = {
      status: () => st,
      refresh: async () => st,
      setEnabled: async (e: boolean) => ({ ...st, enabled: e }),
      setVia: (via: LanVia) => ({ ...st, via }),
      setServe: async () => st,
      pairBegin: () => ({ code: "ABC234", url: "http://x/?code=ABC234", expiresAt: "2026-09-07T10:10:00.000Z" }),
      devices: () => [],
      forget: (id: string) => ((forgot = id), true),
    };
    const bridge = createBridge({ store: new DeskStore(), widgets: fakeWidgets([]), gestures: new GestureLog(), broadcast: (m) => broadcasts.push(m as Record<string, unknown>), lan, listDesks: () => [] });
    const phone = { ...client("shared"), deviceId: "d1" };
    for (const type of ["pair_begin", "device_forget", "lan_set", "lan_get", "lan_via_set", "lan_serve_set", "devices_list", "gesture", "arrange", "trash", "folder_pick", "folder_check", "skill_install", "skills_global", "task_create", "tasks_list", "widget_status", "measure"]) {
      phone.sent.length = 0;
      bridge.onMessage(phone, { type, requestId: "r1", id: "d2", enabled: false });
      expect(phone.sent).toEqual([{ type: "error", requestId: "r1", message: `${type} is not available on the phone` }]);
    }
    expect(forgot).toBeNull();
    expect(broadcasts).toEqual([]);
    for (const type of PHONE_FRAMES) {
      phone.sent.length = 0;
      bridge.onMessage(phone, { type, agentId: "a1", conversationId: "c1", skips: 1, until: "2026-09-07T10:10:00.000Z", stamp: "s", at: "2026-09-07T10:00:00.000Z" });
      expect(phone.sent.some((m) => m.type === "error" && String(m.message).includes("not available on the phone"))).toBe(false);
    }
    // the desktop (no deviceId) keeps everything
    const desk = client("shared");
    bridge.onMessage(desk, { type: "pair_begin" });
    expect(desk.sent.at(-1)?.type).toBe("pair_code");
  });
});

describe("bridge phone frames", () => {
  const tailscale: TailscaleStatus = { installed: true, running: true, ip: "100.101.102.103", name: "my-macbook-pro.tail1234.ts.net", serveUrl: null, error: null };
  const status: LanStatus = { enabled: false, address: "192.168.1.3", addresses: ["192.168.1.3"], host: "my-macbook-pro.local", port: 41415, appServed: true, error: null, via: "tailscale", tailscale };
  function lanDeps() {
    const calls: unknown[] = [];
    let enabled = false;
    let via: LanVia = "tailscale";
    let refreshed = 0;
    let serveError: string | null = null;
    let serveUrl: string | null = null;
    const devices = [{ id: "d1", name: "iPhone", createdAt: "2026-09-07T10:00:00.000Z", lastSeenAt: "2026-09-07T10:00:00.000Z" }];
    const current = (): LanStatus => ({ ...status, enabled, via, tailscale: { ...tailscale, serveUrl, error: serveError } });
    return {
      calls,
      refreshed: () => refreshed,
      lan: {
        status: current,
        refresh: async () => {
          refreshed += 1;
          return current();
        },
        setEnabled: async (e: boolean) => {
          calls.push(["setEnabled", e]);
          enabled = e;
          return current();
        },
        setVia: (v: LanVia) => {
          calls.push(["setVia", v]);
          via = v;
          return current();
        },
        setServe: async (e: boolean) => {
          calls.push(["setServe", e]);
          // the stub's tailnet has HTTPS disabled: turning serve on fails with the CLI's words, off works
          if (e) serveError = "Error: HTTPS is not enabled for this tailnet";
          else {
            serveError = null;
            serveUrl = null;
          }
          return current();
        },
        pairBegin: () => ({ code: "ABC234", url: "http://192.168.1.3:41415/?code=ABC234", expiresAt: "2026-09-07T10:10:00.000Z" }),
        devices: () => devices,
        forget: (id: string) => {
          calls.push(["forget", id]);
          const i = devices.findIndex((d) => d.id === id);
          if (i < 0) return false;
          devices.splice(i, 1);
          return true;
        },
      },
    };
  }

  test("lan_get / lan_set / pair_begin / devices_list / device_forget", async () => {
    const broadcasts: Array<Record<string, unknown>> = [];
    const d = lanDeps();
    const bridge = createBridge({ store: new DeskStore(), widgets: fakeWidgets([]), gestures: new GestureLog(), broadcast: (m) => broadcasts.push(m as Record<string, unknown>), lan: d.lan });
    const c = client("c1");
    bridge.onMessage(c, { type: "lan_get" });
    await new Promise((r) => setTimeout(r, 0));
    expect(d.refreshed()).toBe(1); // lan_get asks Tailscale again before answering
    expect(c.sent.at(-1)).toEqual({ type: "lan_status", ...status });
    bridge.onMessage(c, { type: "lan_set", enabled: true });
    await new Promise((r) => setTimeout(r, 0));
    expect(d.calls).toEqual([["setEnabled", true]]);
    expect(c.sent.at(-1)).toEqual({ type: "lan_status", ...status, enabled: true });
    bridge.onMessage(c, { type: "pair_begin" });
    expect(c.sent.at(-1)).toEqual({ type: "pair_code", code: "ABC234", url: "http://192.168.1.3:41415/?code=ABC234", expiresAt: "2026-09-07T10:10:00.000Z" });
    bridge.onMessage(c, { type: "devices_list" });
    expect(c.sent.at(-1)).toEqual({ type: "devices", devices: [{ id: "d1", name: "iPhone", createdAt: "2026-09-07T10:00:00.000Z", lastSeenAt: "2026-09-07T10:00:00.000Z" }] });
    bridge.onMessage(c, { type: "device_forget", id: "d1" });
    expect(d.calls.at(-1)).toEqual(["forget", "d1"]);
    expect(broadcasts.at(-1)).toEqual({ type: "devices", devices: [] });
  });

  test("lan_via_set persists the route and answers lan_status; a bad via is an error", () => {
    const d = lanDeps();
    const bridge = createBridge({ store: new DeskStore(), widgets: fakeWidgets([]), gestures: new GestureLog(), broadcast: () => {}, lan: d.lan });
    const c = client("c1");
    bridge.onMessage(c, { type: "lan_via_set", via: "lan" });
    expect(d.calls).toEqual([["setVia", "lan"]]);
    expect(c.sent.at(-1)).toEqual({ type: "lan_status", ...status, via: "lan" });
    bridge.onMessage(c, { type: "lan_via_set", via: "tailscale" });
    expect(c.sent.at(-1)).toMatchObject({ type: "lan_status", via: "tailscale" });
    bridge.onMessage(c, { type: "lan_via_set", via: "carrier-pigeon" });
    expect(c.sent.at(-1)).toMatchObject({ type: "error" });
    expect(d.calls).toHaveLength(2);
  });

  test("lan_serve_set turns the https front on or off; a CLI failure rides in tailscale.error, not an error frame", async () => {
    const d = lanDeps();
    const bridge = createBridge({ store: new DeskStore(), widgets: fakeWidgets([]), gestures: new GestureLog(), broadcast: () => {}, lan: d.lan });
    const c = client("c1");
    bridge.onMessage(c, { type: "lan_serve_set", enabled: true });
    await new Promise((r) => setTimeout(r, 0));
    expect(d.calls).toEqual([["setServe", true]]);
    expect(c.sent.at(-1)).toEqual({ type: "lan_status", ...status, tailscale: { ...tailscale, error: "Error: HTTPS is not enabled for this tailnet" } });
    expect(c.sent.some((m) => m.type === "error")).toBe(false);
    bridge.onMessage(c, { type: "lan_serve_set", enabled: false });
    await new Promise((r) => setTimeout(r, 0));
    expect(d.calls.at(-1)).toEqual(["setServe", false]);
    expect(c.sent.at(-1)).toEqual({ type: "lan_status", ...status });
  });

  test("without a listener the frames answer with an error", () => {
    const bridge = createBridge({ store: new DeskStore(), widgets: fakeWidgets([]), gestures: new GestureLog(), broadcast: () => {} });
    const c = client("c1");
    bridge.onMessage(c, { type: "lan_get" });
    expect(c.sent[0]).toMatchObject({ type: "error" });
  });
});

describe("recall frames", () => {
  test("list, grade, edit, reject, restore, settings and export round-trip through the bridge; the phone may read and review", async () => {
    const { RecallStore } = await import("../mod/recall.ts");
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "loki-recall-b-"));
    try {
      const store = new RecallStore(dir);
      store.add({ id: "k1", front: "Q1?", back: "A1", tags: ["t"], source: { agentId: "a", agentName: "ira", conversationId: "c", title: null, at: null }, createdAt: "2026-09-10T08:00:00Z", updatedAt: "2026-09-10T08:00:00Z", updatedBy: "recall", previous: [] });
      const broadcasts: Array<Record<string, unknown>> = [];
      const bridge = createBridge({ store: new DeskStore(), widgets: fakeWidgets([]), gestures: new GestureLog(), broadcast: (m) => broadcasts.push(m as Record<string, unknown>), recall: { store, run: async () => ({ note: "ran" }) } });
      const c = client("c1");
      bridge.onMessage(c, { type: "recall_list", requestId: "r1" });
      const list = c.sent.pop()!;
      expect(list.type).toBe("recall");
      expect((list.cards as unknown[]).length).toBe(1);
      expect((list.worker as { dailyCap: number }).dailyCap).toBe(10);
      bridge.onMessage(c, { type: "recall_grade", requestId: "r2", id: "k1", grade: 3 });
      const graded = c.sent.pop()!;
      expect(graded.type).toBe("recall_card");
      expect((graded.card as { schedule: { reps: number } }).schedule.reps).toBe(1);
      expect(broadcasts.at(-1)).toEqual({ type: "recall_changed" });
      bridge.onMessage(c, { type: "recall_grade", requestId: "r3", id: "k1", grade: 9 });
      expect(c.sent.pop()!.type).toBe("recall_error");
      bridge.onMessage(c, { type: "recall_edit", requestId: "r4", id: "k1", back: "A1 better" });
      expect((c.sent.pop()!.card as { card: { back: string; updatedBy: string } }).card).toMatchObject({ back: "A1 better", updatedBy: "you" });
      bridge.onMessage(c, { type: "recall_reject", requestId: "r5", id: "k1" });
      expect(c.sent.pop()!.card).toBeNull();
      expect(store.cards()).toEqual([]);
      bridge.onMessage(c, { type: "recall_restore", requestId: "r6", id: "k1" });
      expect((c.sent.pop()!.card as { card: { id: string } }).card.id).toBe("k1");
      bridge.onMessage(c, { type: "recall_settings", requestId: "r7", dailyCap: 3, model: "anthropic/claude-haiku-4-5", enabled: false });
      expect((c.sent.pop()!.worker as { dailyCap: number; model: string; enabled: boolean })).toMatchObject({ dailyCap: 3, model: "anthropic/claude-haiku-4-5", enabled: false });
      bridge.onMessage(c, { type: "recall_export", requestId: "r8" });
      expect(c.sent.pop()!.tsv).toBe("Q1?\tA1 better\tt\n");
      bridge.onMessage(c, { type: "recall_run", requestId: "r9" });
      await new Promise((r) => setTimeout(r, 0));
      expect(c.sent.pop()).toMatchObject({ type: "recall_ran", note: "ran" });
      // a phone may review but not change the worker's settings
      const phone = { ...client("p"), deviceId: "d1" } as Client & { sent: Array<Record<string, unknown>> };
      bridge.onMessage(phone, { type: "recall_grade", requestId: "p1", id: "k1", grade: 4 });
      expect(phone.sent.pop()!.type).toBe("recall_card");
      bridge.onMessage(phone, { type: "recall_settings", requestId: "p2", enabled: true });
      expect(phone.sent.pop()!.type).toBe("error");
      // no store wired: a clear error
      const bare = createBridge({ store: new DeskStore(), widgets: fakeWidgets([]), gestures: new GestureLog(), broadcast: () => {} });
      bare.onMessage(c, { type: "recall_list", requestId: "x" });
      expect(c.sent.pop()).toMatchObject({ type: "recall_error" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
