import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { USAGE_ACTIONS, formatUsageReport, parseUsage, usageLine, usageReport, type UsageLine } from "../core/usage.ts";
import { createUsageLog } from "../mod/usage.ts";
import { PHONE_FRAMES, createBridge } from "../mod/bridge.ts";
import { DeskStore } from "../mod/desk-store.ts";
import { GestureLog } from "../mod/gestures.ts";
import type { Client } from "../mod/server.ts";
import type { WidgetsWatcher } from "../mod/widgets-fs.ts";

const NOW = Date.parse("2026-09-22T18:00:00Z");
const at = (daysAgo: number, hour = 10) => new Date(NOW - daysAgo * 86_400_000 - (18 - hour) * 3_600_000).toISOString();
const line = (daysAgo: number, action: string, detail?: Record<string, unknown>, surface: UsageLine["surface"] = "mac", hour = 10): UsageLine => ({ at: at(daysAgo, hour), surface, action, ...(detail ? { detail } : {}) });

describe("usage log: the shape", () => {
  test("a line is time, surface, action and an optional detail; an empty detail is left out", () => {
    const now = new Date("2026-09-22T12:00:00Z");
    expect(usageLine("mac", "view", { to: "inbox" }, now)).toEqual({ at: "2026-09-22T12:00:00.000Z", surface: "mac", action: "view", detail: { to: "inbox" } });
    expect(usageLine("mod", "turn", {}, now)).toEqual({ at: "2026-09-22T12:00:00.000Z", surface: "mod", action: "turn" });
  });

  test("parsing skips what is not a usage line and keeps the rest", () => {
    const text = [JSON.stringify(usageLine("mac", "view", { to: "board" })), "not json", '{"at":"nope","surface":"mac","action":"view"}', '{"at":"2026-09-22T12:00:00Z","surface":"tv","action":"view"}', "", JSON.stringify(usageLine("phone", "seen"))].join("\n");
    expect(parseUsage(text).map((l) => [l.surface, l.action])).toEqual([["mac", "view"], ["phone", "seen"]]);
  });
});

describe("usage log: the report", () => {
  const lines: UsageLine[] = [
    line(0, "view", { to: "inbox", from: "desk" }),
    line(0, "view", { to: "desk", from: "inbox" }),
    line(1, "view", { to: "inbox", from: "desk" }),
    line(1, "desk", { scope: "a" }),
    line(0, "desk", { scope: "b" }),
    line(0, "pass", { decided: 4, next: 2, later: 1, approve: 1, deny: 0, replies: 1 }),
    line(1, "pass", { decided: 2, next: 1, later: 1, approve: 0, deny: 0, replies: 0 }),
    line(2, "pass", { decided: 9, next: 9, later: 0, approve: 0, deny: 0, replies: 0 }),
    line(0, "send", { origin: "desk", images: 1, queued: false }),
    line(0, "send", { origin: "desk", images: 0, queued: true }),
    line(1, "send", { origin: "inbox", images: 0, queued: false }),
    line(1, "send", { origin: null, images: 0, queued: false }, "phone"),
    line(0, "turn", { desk: "a" }, "mod"),
    line(0, "turn", { desk: "a" }, "mod"),
    line(2, "turn", { desk: "b" }, "mod"),
    line(0, "model", { handle: "openai/gpt-5", effort: "high" }),
    line(1, "seen", undefined, "phone"),
    line(1, "later", { skips: 1 }, "phone"),
    line(1, "seen"),
    line(40, "view", { to: "agents", from: "desk" }), // outside a 30-day window
  ];
  const r = usageReport(lines, { now: NOW, days: 30 });

  test("the window keeps the last N days and counts active days and surfaces", () => {
    expect(r.window.lines).toBe(lines.length - 1);
    expect(r.window.activeDays).toBe(3);
    expect(r.surfaces).toEqual({ mac: 13, phone: 3, mod: 3 });
    expect(r.window.from?.slice(0, 10)).toBe(at(2).slice(0, 10));
  });

  test("views by name, desks by turns, sends by origin (the phone's by its surface)", () => {
    expect(r.views).toEqual([["inbox", 2], ["desk", 1]]);
    expect(r.desks).toEqual({ turns: 3, byDesk: [["a", 2], ["b", 1]], distinct: 2, switches: 2 });
    expect(r.chat.sends).toEqual([["desk", 2], ["inbox", 1], ["phone", 1]]);
    expect(r.chat.images).toBe(1);
    expect(r.chat.queued).toBe(1);
    expect(r.chat.models).toEqual([["openai/gpt-5 · high", 1]]);
  });

  test("the inbox: passes, their decisions, the median per pass, and the phone's swipes apart", () => {
    expect(r.inbox).toEqual({ passes: 3, decided: 15, perPass: 4, next: 12, later: 2, approve: 1, deny: 0, replies: 1, phone: { seen: 1, later: 1 } });
  });

  test("hours and weekdays add up to the lines; unused lists every known action that did not happen", () => {
    expect(r.hours.reduce((a, b) => a + b, 0)).toBe(r.window.lines);
    expect(r.weekdays.reduce((a, b) => a + b, 0)).toBe(r.window.lines);
    expect(r.unused).toEqual(Object.keys(USAGE_ACTIONS).filter((a) => !["view", "desk", "pass", "send", "turn", "model", "seen", "later"].includes(a)));
    expect(r.unused).toContain("trash");
  });

  test("the text report names its sections and the empty window says so", () => {
    const text = formatUsageReport(r);
    for (const s of ["views opened", "inbox", "desks · 3 turns on 2 desks", "sends by origin", "not used in this window"]) expect(text).toContain(s);
    expect(text).toContain("median 4 per pass");
    expect(formatUsageReport(usageReport([], { now: NOW, days: 7 }))).toBe("usage · last 7 days · 0 lines on 0 active days");
  });
});

describe("usage log: the writer", () => {
  test("appends one JSON line per action, refuses a bad action name, and rotates past the cap", () => {
    const dir = mkdtempSync(join(tmpdir(), "loki-usage-"));
    const path = join(dir, "logs", "usage.jsonl");
    const now = new Date("2026-09-22T12:00:00Z");
    const log = createUsageLog(path, { maxBytes: 200, checkEvery: 3, now: () => now });
    expect(log.record("mac", "view", { to: "inbox" })).toBe(true);
    expect(log.record("mac", "View Bad")).toBe(false);
    expect(log.record("mod", "turn", { desk: "a" })).toBe(true);
    expect(parseUsage(readFileSync(path, "utf8"))).toEqual([
      { at: "2026-09-22T12:00:00.000Z", surface: "mac", action: "view", detail: { to: "inbox" } },
      { at: "2026-09-22T12:00:00.000Z", surface: "mod", action: "turn", detail: { desk: "a" } },
    ]);
    writeFileSync(path, "x".repeat(400)); // past the cap: the next size check renames it
    log.record("mac", "chat", { open: true });
    log.record("mac", "chat", { open: false });
    expect(existsSync(`${path}.1`)).toBe(true);
    expect(parseUsage(readFileSync(path, "utf8")).length).toBeGreaterThanOrEqual(1);
  });

  test("no path (LOKI_USAGE_LOG=0): nothing is written and nothing throws", () => {
    const log = createUsageLog(null);
    expect(log.record("mac", "view")).toBe(false);
  });
});

describe("usage log: through the bridge", () => {
  const widgets: WidgetsWatcher = { entries: () => [], get: () => undefined, setRuntimeError: () => false, rescan: async () => {}, close() {} };
  const client = (scope: string, deviceId?: string): Client & { sent: Array<Record<string, unknown>> } => {
    const sent: Array<Record<string, unknown>> = [];
    return { scope, deviceId, sent, send: (m) => sent.push(m as Record<string, unknown>) };
  };

  test("a usage frame is recorded for its client, phones included; a malformed one is refused", () => {
    const recorded: Array<[string | undefined, string, Record<string, unknown> | undefined]> = [];
    const bridge = createBridge({ store: new DeskStore(), widgets, gestures: new GestureLog(), broadcast: () => {}, usage: (c, action, detail) => recorded.push([c.deviceId, action, detail]) });
    const mac = client("c1");
    const phone = client("c1", "dev-1");
    bridge.onMessage(mac, { type: "usage", action: "view", detail: { to: "inbox", from: "desk" } });
    bridge.onMessage(phone, { type: "usage", action: "view", detail: { to: "learn" } });
    bridge.onMessage(mac, { type: "usage", action: "Bad Name", detail: {} });
    bridge.onMessage(mac, { type: "usage", action: "chat", detail: [1, 2] });
    expect(recorded).toEqual([
      [undefined, "view", { to: "inbox", from: "desk" }],
      ["dev-1", "view", { to: "learn" }],
      [undefined, "chat", undefined],
    ]);
    expect(mac.sent).toEqual([{ type: "error", message: "malformed usage" }]);
    expect(PHONE_FRAMES.has("usage")).toBe(true);
  });

  test("the inbox frames the mod already handles are noted as actions", () => {
    const recorded: string[] = [];
    const seen = { mark() {}, unmark() {}, setSnooze() {}, clearSnooze() {}, all: () => ({}), snoozes: () => ({}), ladder: () => ({ firstMinutes: 30, growth: 2 }), setLadder() {} };
    const bridge = createBridge({ store: new DeskStore(), widgets, gestures: new GestureLog(), broadcast: () => {}, seen: seen as never, usage: (_c, action, detail) => recorded.push(detail ? `${action} ${JSON.stringify(detail)}` : action) });
    const c = client("c1", "dev-1");
    bridge.onMessage(c, { type: "seen_mark", agentId: "a", conversationId: "x" });
    bridge.onMessage(c, { type: "snooze_set", agentId: "a", conversationId: "x", skips: 2, until: "2026-09-22T13:00:00Z", stamp: "s", at: "2026-09-22T12:00:00Z" });
    bridge.onMessage(c, { type: "seen_unmark", agentId: "a", conversationId: "x" });
    bridge.onMessage(c, { type: "snooze_clear", agentId: "a", conversationId: "x" });
    expect(recorded).toEqual(["seen", 'later {"skips":2}', "unread", "unsnooze"]);
  });
});
