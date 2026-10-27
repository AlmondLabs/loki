import { describe, expect, test } from "vitest";
import { sortDesks } from "../mod/frames/desks.ts";
import { bridgeOf } from "./fixtures/frames.ts";
import { createBridge } from "../mod/bridge.ts";
import { welcomeFrames, type ModuleDeps } from "../mod/frames/index.ts";
import { PHONE_FRAMES } from "../core/frames.ts";
import { scopeOfId } from "../core/desk-core.ts";
import { DeskStore } from "../mod/desk-store.ts";
import { GestureLog } from "../mod/gestures.ts";
import type { WidgetsWatcher } from "../mod/widgets-fs.ts";
import { scopeFor, type WidgetManifestEntry } from "../core/desk-core.ts";
import { WidgetLog } from "../mod/widget-log.ts";
import type { Client } from "../mod/server.ts";
import { join } from "node:path";
import { must } from "./fixtures/must.ts";
import type { DeskSummary, LanStatus, LanVia, TailscaleStatus } from "../core/frame-types.ts";
import { LEAN_DETAIL_MAX, type TranscriptRow } from "../core/attention/transcript.ts";

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
    close: () => {},
  };
}

const sleep: WidgetManifestEntry = {
  id: "c1/sleep",
  scope: "c1",
  name: "sleep",
  kind: "json",
  file: "c1/sleep.json",
  title: "Sleep",
  type: "slider-control",
  data: { value: 6 },
  hash: "h",
  updated_at: 0,
};
const welcome: WidgetManifestEntry = {
  ...sleep,
  id: "shared/welcome",
  scope: "shared",
  name: "welcome",
  file: "shared/welcome.json",
  title: "loki",
  type: "info-card",
  data: { lines: [] },
};

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
    const bridge = bridgeOf({ store, widgets: fakeWidgets([sleep, welcome]), gestures: new GestureLog(), broadcast: (m) => broadcasts.push(m) });
    const c = client("c1");
    bridge.onConnect(c);
    expect(c.sent.map((m) => [m.type, m.scope])).toEqual([
      ["desk", "c1"],
      ["desk", "shared"],
    ]);
    expect((c.sent[0].widgets as unknown[]).length).toBe(1);
    const s = client("shared");
    bridge.onConnect(s);
    expect(s.sent.map((m) => m.type)).toEqual(["desk"]);
  });

  test("a tab opened on another Mac's chat asks that Mac for its desk, and gets no empty one from here", async () => {
    const deps: ModuleDeps = { store: new DeskStore(), widgets: fakeWidgets([sleep, welcome]), gestures: new GestureLog() };
    const forwarded: Array<Record<string, unknown>> = [];
    const route = {
      target: (msg: Record<string, unknown>) => (msg.scope === "c9" ? { mac: "mini", reachable: true } : null),
      redirect: () => null,
      forward: (_home: { mac: string; reachable: boolean }, msg: Record<string, unknown>) => (
        forwarded.push(msg),
        Promise.resolve({ ok: true as const, reply: null })
      ),
    };
    const bridge = createBridge({ modules: [], welcome: welcomeFrames(deps), broadcast: () => {}, route });
    const remote = client("c9");
    bridge.onConnect(remote);
    await Promise.resolve();
    expect(remote.sent.map((m) => [m.type, m.scope])).toEqual([["desk", "shared"]]);
    expect(forwarded).toEqual([{ type: "desk_get", scope: "c9" }]);
    const local = client("c1");
    bridge.onConnect(local);
    expect(local.sent.map((m) => [m.type, m.scope])).toEqual([
      ["desk", "c1"],
      ["desk", "shared"],
    ]);
    expect(forwarded).toHaveLength(1);
  });

  test("gesture updates the widget's desk and logs under the widget's desk with before-value", () => {
    const store = new DeskStore();
    const gestures = new GestureLog();
    const bridge = bridgeOf({ store, widgets: fakeWidgets([sleep, welcome]), gestures, broadcast: () => {} });
    const c = client("c1");
    bridge.onMessage(c, { type: "gesture", gesture: { kind: "set", id: "c1/sleep", path: "value", value: 7 } });
    bridge.onMessage(c, { type: "gesture", gesture: { kind: "move", id: "shared/welcome", position: { x: 3, y: 4 } } });
    bridge.onMessage(c, { type: "gesture", gesture: { kind: "focus", id: "shared/welcome" } });
    expect(store.get("c1").overlay["c1/sleep"]).toEqual({ value: 7 });
    expect(store.get("shared").layout["shared/welcome"].position).toEqual({ x: 3, y: 4 });
    // Each under its own desk: the shared one's moves reach every chat's next turn (turn_start drains both).
    expect(gestures.peek("c1")).toEqual(['set value = 7 (was 6) on "Sleep" (c1/sleep)']);
    expect(gestures.peek("shared")).toEqual(['moved "loki" (shared/welcome) to (3, 4)']);
    bridge.onMessage(c, { type: "gesture", gesture: { kind: "move", id: "c1/sleep" } });
    expect(c.sent.at(-1)).toEqual({ type: "error", message: "malformed gesture" });
  });

  test("a widget used inline in another chat's thread: its desk records it, and that tab gets the desk's state back", () => {
    const store = new DeskStore();
    const gestures = new GestureLog();
    const bridge = bridgeOf({ store, widgets: fakeWidgets([sleep]), gestures, broadcast: () => {} });
    const inbox = client("other-desk");
    bridge.onMessage(inbox, { type: "gesture", gesture: { kind: "set", id: "c1/sleep", path: "value", value: 8 } });
    expect(gestures.peek("c1")).toEqual(['set value = 8 (was 6) on "Sleep" (c1/sleep)']);
    expect(gestures.peek("other-desk")).toEqual([]);
    expect(inbox.sent.at(-1)).toMatchObject({ type: "state", scope: "c1", state: { overlay: { "c1/sleep": { value: 8 } } } });
  });

  test("desk_get answers with another desk's frame, for widgets shown inline; the phone may ask too", () => {
    const bridge = bridgeOf({ store: new DeskStore(), widgets: fakeWidgets([sleep]), gestures: new GestureLog(), broadcast: () => {} });
    const c = client("shared");
    bridge.onMessage(c, { type: "desk_get", scope: "c1" });
    expect(c.sent.at(-1)).toMatchObject({ type: "desk", scope: "c1", widgets: [expect.objectContaining({ id: "c1/sleep" })] });
    expect(PHONE_FRAMES.has("desk_get")).toBe(true);
    expect(PHONE_FRAMES.has("gesture")).toBe(false);
  });

  test("widget_status broadcasts the manifest and logs errors once", () => {
    const store = new DeskStore();
    const gestures = new GestureLog();
    const broadcasts: Array<[Record<string, unknown>, string | undefined]> = [];
    const widgets = fakeWidgets([sleep]);
    const bridge = bridgeOf({ store, widgets, gestures, broadcast: (m, s) => broadcasts.push([m as Record<string, unknown>, s]) });
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
    const bridge = bridgeOf({
      store: new DeskStore(),
      widgets: fakeWidgets([sleep]),
      gestures: new GestureLog(),
      broadcast: () => {},
      deskInfo: (s) =>
        s === "c1"
          ? {
              title: "[Short] - Sleep tracking",
              status: "archived",
              agent_name: "ira",
              agent_id: "a1",
              model: "anthropic/claude-fable-5",
              reasoning_effort: "high",
            }
          : s === "gone"
            ? { title: null, status: "deleted", agent_name: null, agent_id: null, model: null, reasoning_effort: null }
            : { title: "shared", status: "none", agent_name: null, agent_id: null, model: null, reasoning_effort: null },
    });
    const c = client("c1");
    bridge.onConnect(c);
    expect(c.sent[0]).toMatchObject({
      type: "desk",
      scope: "c1",
      title: "[Short] - Sleep tracking",
      status: "archived",
      agent_name: "ira",
      reasoning_effort: "high",
    });
    expect(c.sent[1]).toMatchObject({ type: "desk", scope: "shared", title: "shared", status: "none" });
    bridge.onConnect(client("gone"));
    await new Promise((r) => setTimeout(r, 10));
  });

  test("sortDesks: shared, then live (pinned, active, then recent), then archived, then deleted", () => {
    const d = (scope: string, status: DeskSummary["status"], extra: Partial<DeskSummary> = {}): DeskSummary => ({
      scope,
      status,
      title: null,
      agent_name: null,
      agent_id: null,
      conversation_id: null,
      model: null,
      reasoning_effort: null,
      widgets: 0,
      active: false,
      last_active: null,
      ...extra,
    });
    const sorted = sortDesks([
      d("old", "live", { last_active: "2026-09-01T00:00:00Z" }),
      d("gone", "deleted"),
      d("arch", "archived", { last_active: "2026-09-03T00:00:00Z" }),
      d("shared", "none"),
      d("now", "live", { active: true, last_active: "2026-08-01T00:00:00Z" }),
      d("new", "live", { last_active: "2026-09-02T00:00:00Z" }),
      d("pinned", "live", { pinned: true, last_active: "2026-07-01T00:00:00Z" }),
    ]).map((x) => x.scope);
    expect(sorted).toEqual(["shared", "pinned", "now", "new", "old", "arch", "gone"]);
  });

  test("list_desks replies with the mod's desk list", () => {
    const desks: DeskSummary[] = [
      {
        scope: "shared",
        title: "shared",
        status: "none",
        agent_name: null,
        agent_id: null,
        conversation_id: null,
        model: null,
        reasoning_effort: null,
        widgets: 1,
        active: false,
        last_active: null,
      },
    ];
    const bridge = bridgeOf({ store: new DeskStore(), widgets: fakeWidgets([]), gestures: new GestureLog(), broadcast: () => {}, listDesks: () => desks });
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
    const bridge = bridgeOf({ store, widgets: fakeWidgets([]), gestures, broadcast: (m, s) => broadcasts.push([m as Record<string, unknown>, s]) });
    const c = client("c1");
    bridge.onMessage(c, { type: "measure", id: "c1/a", size: { w: 280, h: 240 } });
    expect(store.get("c1").layout["c1/a"].size).toEqual({ w: 280, h: 240 });
    bridge.onMessage(c, { type: "measure", id: "c1/a", size: { w: "x" } }); // ignored
    bridge.onMessage(c, { type: "arrange" });
    const a = store.get("c1").layout["c1/a"].position;
    const b = store.get("c1").layout["c1/b"].position;
    expect(a).not.toEqual(b);
    expect(gestures.peek("c1")).toEqual(["tidied the canvas (auto-arranged 2 widgets)"]);
    expect(broadcasts.at(-1)?.[0]).toMatchObject({ type: "camera", widget_ids: expect.arrayContaining(["c1/a", "c1/b"]) as unknown });
  });

  test("trash deletes the file through the mod, forgets the layout, and tells the agent", () => {
    const store = new DeskStore();
    store.seen("c1", "c1/sleep");
    const gestures = new GestureLog();
    const deleted: string[] = [];
    const bridge = bridgeOf({
      store,
      widgets: fakeWidgets([sleep]),
      gestures,
      broadcast: () => {},
      deleteWidgetFile: (id) => (deleted.push(id), `/w/${id}.json`),
    });
    const c = client("c1");
    bridge.onMessage(c, { type: "trash", id: "c1/sleep" });
    expect(deleted).toEqual(["c1/sleep"]);
    expect(store.get("c1").layout["c1/sleep"]).toBeUndefined();
    expect(gestures.peek("c1")).toEqual(['trashed "Sleep" (c1/sleep) — its file was deleted']);
    const failing = bridgeOf({ store, widgets: fakeWidgets([sleep]), gestures: new GestureLog(), broadcast: () => {}, deleteWidgetFile: () => null });
    const c2 = client("c1");
    failing.onMessage(c2, { type: "trash", id: "c1/sleep" });
    expect(c2.sent[0]).toMatchObject({ type: "error" });
  });

  test("unknown message types get an error frame", () => {
    const bridge = bridgeOf({ store: new DeskStore(), widgets: fakeWidgets([]), gestures: new GestureLog(), broadcast: () => {} });
    const c = client("c1");
    bridge.onMessage(c, { type: "wat" });
    expect(c.sent[0]).toEqual({ type: "error", message: "unsupported message type: wat" });
  });
});

describe("bridge: viewed", () => {
  test("viewed_mark stamps a look and broadcasts the seen frame with it; seen_list carries it; the phone may send it", async () => {
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { SeenStore } = await import("../mod/seen.ts");
    const dir = mkdtempSync(join(tmpdir(), "loki-seen-"));
    try {
      const seen = new SeenStore(join(dir, "attention.json"));
      const broadcasts: Array<Record<string, unknown>> = [];
      const bridge = bridgeOf({
        store: new DeskStore(),
        widgets: fakeWidgets([]),
        gestures: new GestureLog(),
        broadcast: (m) => broadcasts.push(m as Record<string, unknown>),
        seen,
      });
      const c = client("c1");
      bridge.onMessage(c, { type: "viewed_mark", agent_id: "a", conversation_id: "x" });
      const frame = must(broadcasts.at(-1), "the seen frame");
      expect(frame.type).toBe("seen");
      expect(Object.keys(frame.viewed as object)).toEqual(["a/x"]);
      expect(frame.seen).toEqual({}); // a look is not done
      bridge.onMessage(c, { type: "seen_list" });
      expect(c.sent.at(-1)).toMatchObject({ type: "seen", viewed: { "a/x": expect.any(String) as unknown } });
      expect(PHONE_FRAMES.has("viewed_mark")).toBe(true);
      // Learn's leads work from the phone (a lesson started there opens its conversation); the writer's settings do not.
      for (const type of ["recall_lead_start", "recall_lead_dismiss", "recall_lead_restore"] as const) expect(PHONE_FRAMES.has(type)).toBe(true);
      expect(PHONE_FRAMES.has("recall_settings")).toBe(false);
      seen.flush();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("bridge: focus", () => {
  test("a look adds a read's weight; focus_add adds answers and decisions, from the phone too; the seen frame carries it", async () => {
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { SeenStore } = await import("../mod/seen.ts");
    const dir = mkdtempSync(join(tmpdir(), "loki-focus-"));
    try {
      const seen = new SeenStore(join(dir, "attention.json"));
      const broadcasts: Array<Record<string, unknown>> = [];
      const bridge = bridgeOf({
        store: new DeskStore(),
        widgets: fakeWidgets([]),
        gestures: new GestureLog(),
        broadcast: (m) => broadcasts.push(m as Record<string, unknown>),
        seen,
      });
      const c = client("c1");
      bridge.onMessage(c, { type: "viewed_mark", agent_id: "a", conversation_id: "x" });
      expect((must(broadcasts.at(-1), "the seen frame").focus as Record<string, { w: number }>)["a/x"].w).toBe(0.25);
      bridge.onMessage(c, { type: "focus_add", agent_id: "a", conversation_id: "x", action: "answer" });
      bridge.onMessage(c, { type: "focus_add", agent_id: "a", conversation_id: "y", action: "decide" });
      const focus = must(broadcasts.at(-1), "the seen frame").focus as Record<string, { w: number }>;
      expect(focus["a/x"].w).toBeCloseTo(1.25, 3);
      expect(focus["a/y"].w).toBe(0.5);
      // messages are counted where turns start, never from a client: a client cannot claim one
      const before = broadcasts.length;
      bridge.onMessage(c, { type: "focus_add", agent_id: "a", conversation_id: "x", action: "message" });
      expect(broadcasts.length).toBe(before);
      expect(PHONE_FRAMES.has("focus_add")).toBe(true);
      seen.flush();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("bridge: a mark that changes nothing", () => {
  test("neither writes nor broadcasts", async () => {
    const { mkdtempSync, readFileSync, rmSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { SeenStore } = await import("../mod/seen.ts");
    const dir = mkdtempSync(join(tmpdir(), "loki-seen-"));
    try {
      const path = join(dir, "attention.json");
      const seen = new SeenStore(path, { now: () => "2026-09-25T10:00:00.000Z" });
      const broadcasts: Array<Record<string, unknown>> = [];
      const bridge = bridgeOf({
        store: new DeskStore(),
        widgets: fakeWidgets([]),
        gestures: new GestureLog(),
        broadcast: (m) => broadcasts.push(m as Record<string, unknown>),
        seen,
      });
      const c = client("c1");
      bridge.onMessage(c, { type: "viewed_mark", agent_id: "a", conversation_id: "x" });
      expect(broadcasts.length).toBe(1);
      seen.flush();
      writeFileSync(path, "untouched");
      bridge.onMessage(c, { type: "viewed_mark", agent_id: "a", conversation_id: "x" }); // the same instant: the same look
      bridge.onMessage(c, { type: "seen_unmark", agent_id: "a", conversation_id: "x" }); // not done already
      expect(broadcasts.length).toBe(1);
      seen.flush();
      expect(readFileSync(path, "utf8")).toBe("untouched");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("bridge history", () => {
  test("inbox_list answers with the mod's open conversations and echoes the request id", () => {
    const rows = [
      {
        id: "default",
        agent_id: "a1",
        agent_name: "ira",
        title: "ira · main chat",
        last_message_at: "2026-09-06T11:49:16Z",
        archived: false as const,
        last_role: "assistant" as const,
        last_ask: null,
        last_assistant_text: "It's on your canvas now.",
      },
    ];
    const bridge = bridgeOf({ store: new DeskStore(), widgets: fakeWidgets([]), gestures: new GestureLog(), broadcast: () => {}, listInbox: () => rows });
    const c = client("c1");
    bridge.onMessage(c, { type: "inbox_list", request_id: "i1" });
    expect(c.sent).toEqual([{ type: "inbox", request_id: "i1", conversations: rows }]);
  });
  test("history_get answers with the local transcript and echoes the request id", () => {
    const bridge = bridgeOf({
      store: new DeskStore(),
      widgets: fakeWidgets([sleep]),
      gestures: new GestureLog(),
      broadcast: () => {},
      transcript: (agentId, conversationId) => ({
        rows:
          agentId === "a1" && conversationId === "c9"
            ? [
                { role: "user", text: "hi" },
                { role: "tool", text: "Bash · ls" },
              ]
            : [],
        more: false,
        start: 0,
      }),
    });
    const c = client("c1");
    bridge.onConnect(c);
    bridge.onMessage(c, { type: "history_get", request_id: "h1", agent_id: "a1", conversation_id: "c9" });
    const reply = must(
      c.sent.find((m) => m.type === "history"),
      "the history reply",
    );
    expect(reply).toMatchObject({ request_id: "h1", agent_id: "a1", conversation_id: "c9" });
    expect((reply.messages as unknown[]).length).toBe(2);
    bridge.onMessage(c, { type: "history_get", request_id: "h2", agent_id: "a1", conversation_id: "unknown" });
    expect(c.sent.filter((m) => m.type === "history").at(-1)).toMatchObject({ request_id: "h2", messages: [] });
  });
  test("history_get sends tool rows and long event details lean, and history_step_get makes one row whole (plans 041 and 043)", () => {
    const step = { name: "Bash", id: "t1", input: "ls -la", output: "a\nb" };
    const result = "r".repeat(LEAN_DETAIL_MAX + 1);
    const rows: TranscriptRow[] = [
      { role: "user", text: "hi" },
      { role: "tool", text: "Bash · ls -la", tool: step },
      { role: "event", text: "background task", summary: "done", detail: result },
    ];
    const bridge = bridgeOf({
      store: new DeskStore(),
      widgets: fakeWidgets([]),
      gestures: new GestureLog(),
      broadcast: () => {},
      transcript: () => ({ rows, more: true, start: 7 }),
      row: (agentId, conversationId, row) => (agentId === "a1" && conversationId === "c9" ? (rows[row - 7] ?? null) : null),
    });
    const c = client("c1");
    bridge.onConnect(c);
    bridge.onMessage(c, { type: "history_get", request_id: "h1", agent_id: "a1", conversation_id: "c9" });
    const reply = must(
      c.sent.find((m) => m.type === "history"),
      "the history reply",
    );
    expect(reply.messages).toEqual([
      { role: "user", text: "hi" },
      { role: "tool", text: "Bash · ls -la", tool: { name: "Bash", id: "t1", row: 8 } },
      { role: "event", text: "background task", summary: "done", detail: null, row: 9 },
    ]);
    for (const [id, row] of [
      ["s1", 8],
      ["s2", 9],
      ["s3", 7],
      ["s4", 40],
    ] as const)
      bridge.onMessage(c, { type: "history_step_get", request_id: id, agent_id: "a1", conversation_id: "c9", row });
    expect(c.sent.filter((m) => m.type === "history_step")).toEqual([
      { type: "history_step", request_id: "s1", step, detail: null },
      { type: "history_step", request_id: "s2", step: null, detail: result },
      { type: "history_step", request_id: "s3", step: null, detail: null },
      { type: "history_step", request_id: "s4", step: null, detail: null },
    ]);
  });
  test("history_get pages: the limit asked for (one page at least, a cap at most), and whether older rows remain", () => {
    const asked: number[] = [];
    const bridge = bridgeOf({
      store: new DeskStore(),
      widgets: fakeWidgets([]),
      gestures: new GestureLog(),
      broadcast: () => {},
      transcript: (_a, _c, limit) => (asked.push(limit), { rows: [], more: limit < 1200, start: 0 }),
    });
    const c = client("c1");
    for (const limit of [undefined, 800, 1200, 5, 1e9])
      bridge.onMessage(c, { type: "history_get", request_id: "h", agent_id: "a1", conversation_id: "c1", limit });
    expect(asked).toEqual([400, 800, 1200, 400, 20_000]);
    expect(c.sent.filter((m) => m.type === "history").map((m) => m.more)).toEqual([true, true, false, true, false]);
  });
  test("history_get pages back by position: `before` reaches the transcript, and the reply says where its rows start", () => {
    const asked: Array<number | null> = [];
    const bridge = bridgeOf({
      store: new DeskStore(),
      widgets: fakeWidgets([]),
      gestures: new GestureLog(),
      broadcast: () => {},
      transcript: (_a, _c, limit, before) => (
        asked.push(before),
        { rows: [], more: (before ?? 1000) - limit > 0, start: Math.max(0, (before ?? 1000) - limit) }
      ),
    });
    const c = client("c1");
    for (const before of [undefined, 600, 0, -3, "x"])
      bridge.onMessage(c, { type: "history_get", request_id: "h", agent_id: "a1", conversation_id: "c1", before });
    expect(asked).toEqual([null, 600, 0, null, null]);
    expect(c.sent.filter((m) => m.type === "history").map((m) => [m.start, m.more])).toEqual([
      [600, true],
      [200, true],
      [0, false],
      [600, true],
      [600, true],
    ]);
  });
  test("history carries the desk's widget change log; a desk with none gets an empty list", () => {
    const log = new WidgetLog(null);
    log.record({ added: [sleep], changed: [], removed: [], removedEntries: [], initial: false }, 123);
    const bridge = bridgeOf({
      store: new DeskStore(),
      widgets: fakeWidgets([sleep]),
      gestures: new GestureLog(),
      broadcast: () => {},
      widgetLog: (agentId, conversationId) => log.read(scopeFor(conversationId, agentId)),
    });
    const c = client("c1");
    bridge.onMessage(c, { type: "history_get", request_id: "h1", agent_id: "a1", conversation_id: "c1" });
    bridge.onMessage(c, { type: "history_get", request_id: "h2", agent_id: "a1", conversation_id: "c2" });
    const [one, two] = c.sent.filter((m) => m.type === "history");
    expect(one.widget_log).toEqual([expect.objectContaining({ scope: "c1", widget_id: "c1/sleep", title: "Sleep", kind: "json", change: "added", at: 123 })]);
    expect(two.widget_log).toEqual([]);
  });
  test("a phone's history_get still answers, with the widget log as one more field it may ignore", () => {
    const bridge = bridgeOf({
      store: new DeskStore(),
      widgets: fakeWidgets([]),
      gestures: new GestureLog(),
      broadcast: () => {},
      transcript: () => ({ rows: [{ role: "user", text: "hi" }], more: false, start: 0 }),
      widgetLog: () => [],
    });
    const phone = { ...client("shared"), deviceId: "d1" };
    bridge.onMessage(phone, { type: "history_get", request_id: "p1", agent_id: "a1", conversation_id: "c1" });
    expect(phone.sent).toEqual([
      {
        type: "history",
        request_id: "p1",
        agent_id: "a1",
        conversation_id: "c1",
        messages: [{ role: "user", text: "hi" }],
        more: false,
        start: 0,
        widget_log: [],
      },
    ]);
  });
});

describe("bridge: a paired phone's authority", () => {
  test("a device client gets the inbox frames and nothing else", () => {
    const broadcasts: Array<Record<string, unknown>> = [];
    let forgot: string | null = null;
    const st: LanStatus = {
      enabled: true,
      address: "192.168.1.3",
      addresses: ["192.168.1.3"],
      host: null,
      port: 41415,
      app_served: true,
      error: null,
      via: "lan",
      tailscale: null,
    };
    const lan = {
      status: () => st,
      refresh: () => Promise.resolve(st),
      setEnabled: (e: boolean) => Promise.resolve({ ...st, enabled: e }),
      setVia: (via: LanVia) => ({ ...st, via }),
      setServe: () => Promise.resolve(st),
      pairBegin: () => ({ code: "ABC234", url: "http://x/?code=ABC234", expires_at: "2026-09-07T10:10:00.000Z" }),
      devices: () => [],
      forget: (id: string) => ((forgot = id), true),
    };
    const bridge = bridgeOf({
      store: new DeskStore(),
      widgets: fakeWidgets([]),
      gestures: new GestureLog(),
      broadcast: (m) => broadcasts.push(m as Record<string, unknown>),
      lan,
      listDesks: () => [],
    });
    const phone = { ...client("shared"), deviceId: "d1" };
    for (const type of [
      "pair_begin",
      "device_forget",
      "lan_set",
      "lan_get",
      "lan_via_set",
      "lan_serve_set",
      "devices_list",
      "gesture",
      "arrange",
      "trash",
      "folder_pick",
      "folder_check",
      "skill_install",
      "skills_global",
      "task_assign",
      "task_close",
      "task_reopen",
      "task_status",
      "widget_status",
      "measure",
    ]) {
      phone.sent.length = 0;
      bridge.onMessage(phone, { type, request_id: "r1", id: "d2", enabled: false });
      expect(phone.sent).toEqual([{ type: "error", request_id: "r1", message: `${type} is not available on the phone` }]);
    }
    expect(forgot).toBeNull();
    expect(broadcasts).toEqual([]);
    for (const type of PHONE_FRAMES) {
      phone.sent.length = 0;
      bridge.onMessage(phone, {
        type,
        agent_id: "a1",
        conversation_id: "c1",
        skips: 1,
        until: "2026-09-07T10:10:00.000Z",
        stamp: "s",
        at: "2026-09-07T10:00:00.000Z",
      });
      expect(phone.sent.some((m) => m.type === "error" && String(m.message).includes("not available on the phone"))).toBe(false);
    }
    // the desktop (no deviceId) keeps everything
    const desk = client("shared");
    bridge.onMessage(desk, { type: "pair_begin" });
    expect(desk.sent.at(-1)?.type).toBe("pair_code");
  });
});

describe("bridge phone frames", () => {
  const tailscale: TailscaleStatus = {
    installed: true,
    running: true,
    ip: "100.101.102.103",
    name: "my-macbook-pro.tail1234.ts.net",
    serve_url: null,
    error: null,
  };
  const status: LanStatus = {
    enabled: false,
    address: "192.168.1.3",
    addresses: ["192.168.1.3"],
    host: "my-macbook-pro.local",
    port: 41415,
    app_served: true,
    error: null,
    via: "tailscale",
    tailscale,
  };
  function lanDeps() {
    const calls: unknown[] = [];
    let enabled = false;
    let via: LanVia = "tailscale";
    let refreshed = 0;
    let serveError: string | null = null;
    let serveUrl: string | null = null;
    const devices = [{ id: "d1", name: "iPhone", created_at: "2026-09-07T10:00:00.000Z", last_seen_at: "2026-09-07T10:00:00.000Z" }];
    const current = (): LanStatus => ({ ...status, enabled, via, tailscale: { ...tailscale, serve_url: serveUrl, error: serveError } });
    return {
      calls,
      refreshed: () => refreshed,
      lan: {
        status: current,
        refresh: () => {
          refreshed += 1;
          return Promise.resolve(current());
        },
        setEnabled: (e: boolean) => {
          calls.push(["setEnabled", e]);
          enabled = e;
          return Promise.resolve(current());
        },
        setVia: (v: LanVia) => {
          calls.push(["setVia", v]);
          via = v;
          return current();
        },
        setServe: (e: boolean) => {
          calls.push(["setServe", e]);
          // the stub's tailnet has HTTPS disabled: turning serve on fails with the CLI's words, off works
          if (e) serveError = "Error: HTTPS is not enabled for this tailnet";
          else {
            serveError = null;
            serveUrl = null;
          }
          return Promise.resolve(current());
        },
        pairBegin: () => ({ code: "ABC234", url: "http://192.168.1.3:41415/?code=ABC234", expires_at: "2026-09-07T10:10:00.000Z" }),
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
    const bridge = bridgeOf({
      store: new DeskStore(),
      widgets: fakeWidgets([]),
      gestures: new GestureLog(),
      broadcast: (m) => broadcasts.push(m as Record<string, unknown>),
      lan: d.lan,
    });
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
    expect(c.sent.at(-1)).toEqual({ type: "pair_code", code: "ABC234", url: "http://192.168.1.3:41415/?code=ABC234", expires_at: "2026-09-07T10:10:00.000Z" });
    bridge.onMessage(c, { type: "devices_list" });
    expect(c.sent.at(-1)).toEqual({
      type: "devices",
      devices: [{ id: "d1", name: "iPhone", created_at: "2026-09-07T10:00:00.000Z", last_seen_at: "2026-09-07T10:00:00.000Z" }],
    });
    bridge.onMessage(c, { type: "device_forget", id: "d1" });
    expect(d.calls.at(-1)).toEqual(["forget", "d1"]);
    expect(broadcasts.at(-1)).toEqual({ type: "devices", devices: [] });
  });

  test("lan_via_set persists the route and answers lan_status; a bad via is an error", () => {
    const d = lanDeps();
    const bridge = bridgeOf({ store: new DeskStore(), widgets: fakeWidgets([]), gestures: new GestureLog(), broadcast: () => {}, lan: d.lan });
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
    const bridge = bridgeOf({ store: new DeskStore(), widgets: fakeWidgets([]), gestures: new GestureLog(), broadcast: () => {}, lan: d.lan });
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
    const bridge = bridgeOf({ store: new DeskStore(), widgets: fakeWidgets([]), gestures: new GestureLog(), broadcast: () => {} });
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
    const dir = mkdtempSync(join(tmpdir(), "loki-recall-b-"));
    try {
      const store = new RecallStore(dir);
      store.add({
        id: "k1",
        front: "Q1?",
        back: "A1",
        tags: ["t"],
        source: { agent_id: "a", agent_name: "ira", conversation_id: "c", title: null, at: null },
        created_at: "2026-09-10T08:00:00Z",
        updated_at: "2026-09-10T08:00:00Z",
        updated_by: "recall",
        previous: [],
      });
      const broadcasts: Array<Record<string, unknown>> = [];
      // Learn's settings and status are the daemon's; here a plain object stands in for them.
      const status = { enabled: true, daily_cap: 25, last_run_at: null, last_run_note: null, written_today: 0 };
      const bridge = bridgeOf({
        store: new DeskStore(),
        widgets: fakeWidgets([]),
        gestures: new GestureLog(),
        broadcast: (m) => broadcasts.push(m as Record<string, unknown>),
        recall: { store, status: () => status, setSettings: (s) => (Object.assign(status, s), Promise.resolve()), run: () => Promise.resolve({ note: "ran" }) },
      });
      const c = client("c1");
      bridge.onMessage(c, { type: "recall_list", request_id: "r1" });
      const list = must(c.sent.pop(), "the reply");
      expect(list.type).toBe("recall");
      expect((list.cards as unknown[]).length).toBe(1);
      expect((list.worker as { daily_cap: number }).daily_cap).toBe(25);
      bridge.onMessage(c, { type: "recall_grade", request_id: "r2", id: "k1", grade: 3 });
      const graded = must(c.sent.pop(), "the reply");
      expect(graded.type).toBe("recall_card");
      expect((graded.card as { schedule: { reps: number } }).schedule.reps).toBe(1);
      expect(broadcasts.at(-1)).toEqual({ type: "recall_changed" });
      bridge.onMessage(c, { type: "recall_grade", request_id: "r3", id: "k1", grade: 9 });
      expect(c.sent.pop()).toEqual({ type: "error", request_id: "r3", message: "a grade is 1 (again) to 4 (easy)" });
      bridge.onMessage(c, { type: "recall_edit", request_id: "r4", id: "k1", back: "A1 better" });
      expect((must(c.sent.pop(), "the reply").card as { card: { back: string; updated_by: string } }).card).toMatchObject({
        back: "A1 better",
        updated_by: "you",
      });
      bridge.onMessage(c, { type: "recall_reject", request_id: "r5", id: "k1" });
      expect(must(c.sent.pop(), "the reply").card).toBeNull();
      expect(store.cards()).toEqual([]);
      bridge.onMessage(c, { type: "recall_restore", request_id: "r6", id: "k1" });
      expect((must(c.sent.pop(), "the reply").card as { card: { id: string } }).card.id).toBe("k1");
      bridge.onMessage(c, { type: "recall_settings", request_id: "r7", daily_cap: 3, enabled: false });
      await new Promise((r) => setTimeout(r, 0));
      expect(must(c.sent.pop(), "the reply").worker as { daily_cap: number; enabled: boolean }).toMatchObject({ daily_cap: 3, enabled: false });
      bridge.onMessage(c, { type: "recall_export", request_id: "r8" });
      expect(must(c.sent.pop(), "the reply").tsv).toBe("Q1?\tA1 better\tt\n");
      bridge.onMessage(c, { type: "recall_run", request_id: "r9" });
      await new Promise((r) => setTimeout(r, 0));
      expect(c.sent.pop()).toMatchObject({ type: "recall_ran", note: "ran" });
      // a phone may review but not change the worker's settings
      const phone = { ...client("p"), deviceId: "d1" } as Client & { sent: Array<Record<string, unknown>> };
      bridge.onMessage(phone, { type: "recall_grade", request_id: "p1", id: "k1", grade: 4 });
      expect(must(phone.sent.pop(), "the reply").type).toBe("recall_card");
      bridge.onMessage(phone, { type: "recall_settings", request_id: "p2", enabled: true });
      expect(must(phone.sent.pop(), "the reply").type).toBe("error");
      // no store wired: a clear error
      const bare = bridgeOf({ store: new DeskStore(), widgets: fakeWidgets([]), gestures: new GestureLog(), broadcast: () => {} });
      bare.onMessage(c, { type: "recall_list", request_id: "x" });
      expect(c.sent.pop()).toMatchObject({ type: "error", message: "recall is not available in this mod" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
