import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EVENTS, analyticsReport, formatAnalyticsReport, isEventName, makeEvent, parseEvents, type AnalyticsEvent, type DeviceType } from "../core/analytics.ts";
import { createAnalytics } from "../mod/analytics.ts";
import { PHONE_FRAMES, createBridge } from "../mod/bridge.ts";
import { DeskStore } from "../mod/desk-store.ts";
import { GestureLog } from "../mod/gestures.ts";
import type { Client } from "../mod/server.ts";
import type { WidgetsWatcher } from "../mod/widgets-fs.ts";
import { TABS, screenOf, type Route } from "../app/src/phone/router.ts";

const NOW = Date.parse("2026-09-22T18:00:00Z");
const at = (daysAgo: number, hour = 10, minute = 0) => new Date(NOW - daysAgo * 86_400_000 - (18 - hour) * 3_600_000 + minute * 60_000).toISOString();
const ev = (daysAgo: number, event: string, properties: Record<string, unknown> = {}, device: DeviceType = "mac", session = "s1", minute = 0): AnalyticsEvent => ({
  event,
  timestamp: at(daysAgo, 10, minute),
  distinct_id: "install-1",
  properties: { $device_type: device, $session_id: session, $lib: "loki", ...properties },
});

describe("analytics: the shape", () => {
  test("event names are snake_case object_verb words", () => {
    expect(["view_opened", "inbox_pass_completed", "turn_started", "a1_b2"].every(isEventName)).toBe(true);
    expect(["View", "message sent", "-x", "_x", "x_", "x__y", "a".repeat(49)].some(isEventName)).toBe(false);
  });

  test("an event is name, time, distinct_id and properties, PostHog's shape", () => {
    const now = new Date("2026-09-22T12:00:00Z");
    expect(makeEvent("view_opened", "install-1", { $device_type: "mac", $lib: "loki", view: "inbox" }, now)).toEqual({
      event: "view_opened",
      timestamp: "2026-09-22T12:00:00.000Z",
      distinct_id: "install-1",
      properties: { $device_type: "mac", $lib: "loki", view: "inbox" },
    });
  });

  test("parsing skips what is not an event and keeps the rest", () => {
    const good = ev(0, "view_opened", { view: "board" });
    const text = [JSON.stringify(good), "not json", '{"event":"View","timestamp":"2026-09-22T12:00:00Z","distinct_id":"x","properties":{"$device_type":"mac"}}', '{"event":"view_opened","timestamp":"nope","distinct_id":"x","properties":{"$device_type":"mac"}}', '{"event":"view_opened","timestamp":"2026-09-22T12:00:00Z","distinct_id":"x","properties":{"$device_type":"tv"}}', "", JSON.stringify(ev(0, "conversation_marked_seen", {}, "phone"))].join("\n");
    expect(parseEvents(text).map((e) => [e.properties.$device_type, e.event])).toEqual([["mac", "view_opened"], ["phone", "conversation_marked_seen"]]);
  });
});

describe("analytics: the report", () => {
  const events: AnalyticsEvent[] = [
    ev(0, "view_opened", { view: "inbox", from: "desk", $screen: "desk" }),
    ev(0, "view_opened", { view: "desk", from: "inbox" }, "mac", "s1", 5),
    ev(1, "view_opened", { view: "inbox", from: "desk" }, "mac", "s2"),
    ev(1, "desk_switched", { desk: "a" }, "mac", "s2", 12),
    ev(0, "desk_switched", { desk: "b" }, "mac", "s1", 20),
    ev(0, "inbox_pass_completed", { decided: 4, next: 2, later: 1, approve: 1, deny: 0, replies: 1 }, "mac", "s1", 30),
    ev(1, "inbox_pass_completed", { decided: 2, next: 1, later: 1, approve: 0, deny: 0, replies: 0 }, "mac", "s2"),
    ev(2, "inbox_pass_completed", { decided: 9, next: 9, later: 0, approve: 0, deny: 0, replies: 0 }, "mac", "s3"),
    ev(0, "message_sent", { origin: "desk", images: 1, queued: false }, "mac", "s1"),
    ev(0, "message_sent", { origin: "desk", images: 0, queued: true }, "mac", "s1"),
    ev(1, "message_sent", { origin: "inbox", images: 0, queued: false }, "mac", "s2"),
    ev(1, "message_sent", { origin: null, images: 0, queued: false }, "phone", "p1"),
    ev(0, "turn_started", { desk: "a" }, "mod", "m1"),
    ev(0, "turn_started", { desk: "a" }, "mod", "m1", 3),
    ev(2, "turn_started", { desk: "b" }, "mod", "m2"),
    ev(0, "model_switched", { model: "openai/gpt-5", effort: "high" }, "mac", "s1"),
    ev(1, "conversation_marked_seen", {}, "phone", "p1", 4),
    ev(1, "card_deferred", { skips: 1 }, "phone", "p1", 6),
    ev(1, "conversation_marked_seen", {}, "mac", "s2"),
    ev(40, "view_opened", { view: "agents", from: "desk" }, "mac", "old"), // outside a 30-day window
  ];
  const r = analyticsReport(events, { now: NOW, days: 30 });

  test("the window keeps the last N days, counts active days, and cuts sessions by id", () => {
    expect(r.window.events).toBe(events.length - 1);
    expect(r.window.activeDays).toBe(3);
    expect(r.sessions.count).toBe(6);
    expect(r.sessions.byDevice).toEqual({ mac: 3, phone: 1, mod: 2 });
    expect(r.sessions.medianMinutes).toBe(4.5); // spans: s1 30 · s2 12 · s3 0 · p1 6 · m1 3 · m2 0 → 3 and 6 in the middle
    expect(r.sessions.perActiveDay).toBe(2);
  });

  test("the events table: count, distinct sessions, and the device split", () => {
    const row = (name: string) => r.events.find((e) => e.event === name);
    expect(r.events[0].event).toBe("message_sent");
    expect(row("view_opened")).toEqual({ event: "view_opened", count: 3, sessions: 2, mac: 3, phone: 0, mod: 0 });
    expect(row("turn_started")).toEqual({ event: "turn_started", count: 3, sessions: 2, mac: 0, phone: 0, mod: 3 });
    expect(row("conversation_marked_seen")).toEqual({ event: "conversation_marked_seen", count: 2, sessions: 2, mac: 1, phone: 1, mod: 0 });
  });

  test("breakdowns follow each event's key property; a null value is left out", () => {
    const by = (name: string) => r.breakdowns.find((b) => b.event === name);
    expect(by("view_opened")).toEqual({ event: "view_opened", property: "view", values: [["inbox", 2], ["desk", 1]] });
    expect(by("turn_started")?.values).toEqual([["a", 2], ["b", 1]]);
    expect(by("message_sent")?.values).toEqual([["desk", 2], ["inbox", 1]]);
    expect(by("model_switched")?.values).toEqual([["openai/gpt-5", 1]]);
    expect(by("card_deferred")?.values).toEqual([["1", 1]]);
  });

  test("the inbox: passes, their decisions, the median per pass", () => {
    expect(r.inbox).toEqual({ passes: 3, decided: 15, perPass: 4, next: 12, later: 2, approve: 1, deny: 0, replies: 1 });
  });

  test("hours and weekdays add up to the events; neverFired lists every known event that did not", () => {
    expect(r.hours.reduce((a, b) => a + b, 0)).toBe(r.window.events);
    expect(r.weekdays.reduce((a, b) => a + b, 0)).toBe(r.window.events);
    const fired = new Set(r.events.map((e) => e.event));
    expect(r.neverFired).toEqual(Object.keys(EVENTS).filter((name) => !fired.has(name)));
    expect(r.neverFired).toContain("widget_trashed");
  });

  test("the text report names its parts and the empty period says so", () => {
    const text = formatAnalyticsReport(r);
    for (const s of ["sessions 6 (mac 3 · phone 1 · mod 2)", "event", "message_sent", "breakdowns", "view_opened · view", "inbox passes 3 · 15 cards · median 4 a pass", "never fired"]) expect(text).toContain(s);
    expect(formatAnalyticsReport(analyticsReport([], { now: NOW, days: 7 }))).toBe("analytics · last 7 days · 0 events on 0 active days");
  });
});

describe("analytics: the writer", () => {
  test("fills the system properties, keeps one distinct_id per install, cuts sessions on the gap, rotates past the cap", () => {
    const dir = mkdtempSync(join(tmpdir(), "loki-analytics-"));
    const path = join(dir, "logs", "events.jsonl");
    const statePath = join(dir, "state", "analytics.json");
    let t = Date.parse("2026-09-22T12:00:00Z");
    const a = createAnalytics({ path, statePath, appVersion: "2026.9.22", maxBytes: 600, checkEvery: 3, sessionGapMs: 60_000, now: () => new Date(t) });
    expect(a.capture("mac", "view_opened", { view: "inbox", $screen: "desk", $device_type: "phone" })).toBe(true); // a client cannot claim a device
    t += 30_000;
    expect(a.capture("mac", "chat_opened")).toBe(true);
    t += 120_000; // past the gap: a new session
    expect(a.capture("mac", "chat_closed")).toBe(true);
    expect(a.capture("phone", "conversation_marked_seen")).toBe(true); // phones have their own session
    expect(a.capture("mac", "Bad Name")).toBe(false);
    const lines = parseEvents(readFileSync(path, "utf8"));
    expect(lines.map((e) => e.event)).toEqual(["view_opened", "chat_opened", "chat_closed", "conversation_marked_seen"]);
    expect(lines[0].properties).toEqual({ view: "inbox", $screen: "desk", $device_type: "mac", $session_id: lines[0].properties.$session_id, $app_version: "2026.9.22", $lib: "loki" });
    expect(lines[0].properties.$session_id).toBe(lines[1].properties.$session_id);
    expect(lines[2].properties.$session_id).not.toBe(lines[1].properties.$session_id);
    expect(lines[3].properties.$session_id).not.toBe(lines[2].properties.$session_id);
    expect(new Set(lines.map((e) => e.distinct_id)).size).toBe(1);
    expect(lines[0].distinct_id).toBe(a.distinctId);
    // the id is the install's: a second writer over the same state reads it back
    expect(createAnalytics({ path, statePath }).distinctId).toBe(a.distinctId);
    expect(JSON.parse(readFileSync(statePath, "utf8"))).toEqual({ distinct_id: a.distinctId });
    writeFileSync(path, "x".repeat(1200)); // past the cap: the next size check renames it
    a.capture("mac", "chat_opened");
    a.capture("mac", "chat_closed");
    a.capture("mac", "chat_opened");
    expect(existsSync(`${path}.1`)).toBe(true);
    expect(parseEvents(readFileSync(path, "utf8")).length).toBeGreaterThanOrEqual(1);
  });

  test("no path (LOKI_ANALYTICS=0): nothing is written and nothing throws", () => {
    const dir = mkdtempSync(join(tmpdir(), "loki-analytics-"));
    const a = createAnalytics({ path: null, statePath: join(dir, "analytics.json") });
    expect(a.capture("mac", "view_opened")).toBe(false);
    expect(a.distinctId.length).toBeGreaterThan(0);
  });
});

describe("analytics: through the bridge", () => {
  const widgets: WidgetsWatcher = { entries: () => [], get: () => undefined, setRuntimeError: () => false, rescan: async () => {}, close() {} };
  const client = (scope: string, deviceId?: string): Client & { sent: Array<Record<string, unknown>> } => {
    const sent: Array<Record<string, unknown>> = [];
    return { scope, deviceId, sent, send: (m) => sent.push(m as Record<string, unknown>) };
  };

  test("a capture frame is recorded for its client, phones included; a malformed one is refused", () => {
    const recorded: Array<[string | undefined, string, Record<string, unknown> | undefined]> = [];
    const bridge = createBridge({ store: new DeskStore(), widgets, gestures: new GestureLog(), broadcast: () => {}, capture: (c, event, properties) => recorded.push([c.deviceId, event, properties]) });
    const mac = client("c1");
    const phone = client("c1", "dev-1");
    bridge.onMessage(mac, { type: "capture", event: "view_opened", properties: { view: "inbox", from: "desk", $screen: "desk" } });
    bridge.onMessage(phone, { type: "capture", event: "view_opened", properties: { view: "learn" } });
    bridge.onMessage(mac, { type: "capture", event: "Bad Name", properties: {} });
    bridge.onMessage(mac, { type: "capture", event: "chat_opened", properties: [1, 2] });
    expect(recorded).toEqual([
      [undefined, "view_opened", { view: "inbox", from: "desk", $screen: "desk" }],
      ["dev-1", "view_opened", { view: "learn" }],
      [undefined, "chat_opened", undefined],
    ]);
    expect(mac.sent).toEqual([{ type: "error", message: "malformed capture" }]);
    expect(PHONE_FRAMES.has("capture")).toBe(true);
  });

  test("the inbox frames the mod already handles become events", () => {
    const recorded: string[] = [];
    const seen = { mark() {}, unmark() {}, setSnooze() {}, clearSnooze() {}, all: () => ({}), snoozes: () => ({}), ladder: () => ({ firstMinutes: 30, growth: 2 }), setLadder() {} };
    const bridge = createBridge({ store: new DeskStore(), widgets, gestures: new GestureLog(), broadcast: () => {}, seen: seen as never, capture: (_c, event, properties) => recorded.push(properties ? `${event} ${JSON.stringify(properties)}` : event) });
    const c = client("c1", "dev-1");
    bridge.onMessage(c, { type: "seen_mark", agentId: "a", conversationId: "x" });
    bridge.onMessage(c, { type: "snooze_set", agentId: "a", conversationId: "x", skips: 2, until: "2026-09-22T13:00:00Z", stamp: "s", at: "2026-09-22T12:00:00Z" });
    bridge.onMessage(c, { type: "seen_unmark", agentId: "a", conversationId: "x" });
    bridge.onMessage(c, { type: "snooze_clear", agentId: "a", conversationId: "x" });
    expect(recorded).toEqual(["conversation_marked_seen", 'card_deferred {"skips":2}', "conversation_kept_unread", "deferral_cleared"]);
  });
});

describe("analytics: the phone's screen names", () => {
  // `view` and `$screen` carry these: a word per destination, never which desk, agent or file
  const routes: Array<[Route, string]> = [
    ...TABS.map((tab) => [{ kind: "tab", tab }, tab] as [Route, string]),
    [{ kind: "learn" }, "learn"],
    [{ kind: "search" }, "search"],
    [{ kind: "archive" }, "archive"],
    [{ kind: "preferences" }, "preferences"],
    [{ kind: "agent", agentId: "agent-secret-1" }, "agent"],
    [{ kind: "file", agentId: "agent-secret-1", path: "system/persona.md" }, "file"],
    [{ kind: "conversation", agentId: "agent-secret-1", conversationId: "conv-secret-2", prefill: "hi" }, "conversation"],
  ];
  test("each route has a stable name, More included and You gone", () => {
    for (const [route, name] of routes) expect(screenOf(route)).toBe(name);
    expect(routes.map(([r]) => screenOf(r))).not.toContain("you");
  });
  test("names are plain words with no entity ids", () => {
    for (const [route] of routes) {
      const name = screenOf(route);
      expect(name).toMatch(/^[a-z]+$/);
      expect(name).not.toMatch(/secret|persona/);
    }
  });
});
