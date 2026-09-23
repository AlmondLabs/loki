import { afterEach, describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Transcript } from "../app/src/chat/Transcript.tsx";
import { applyEvent, beginCommand, emptyLive } from "../core/attention/model.ts";
import { carryTimes, fromHistory, type TranscriptRow } from "../core/attention/transcript.ts";
import { toTranscript } from "../core/harness.ts";
import { clockLabel, dayPills, holdMark, unreadBoundary } from "../app/src/shared/thread.ts";

const rt = { agent_id: "a", conversation_id: "c" };
const delta = (message_type: string, extra: Record<string, unknown> = {}) => ({ type: "stream_delta", runtime: rt, delta: { message_type, ...extra } });

describe("message times from history", () => {
  test("history with times yields rows with times; history without yields rows without", () => {
    const timed = toTranscript([
      { message_type: "user_message", content: "hi", date: "2026-09-23T08:00:00Z" },
      { message_type: "assistant_message", content: "hello", date: "2026-09-23T08:00:05Z" },
    ]).map(fromHistory);
    expect(timed).toEqual([
      { role: "user", text: "hi", at: "2026-09-23T08:00:00Z" },
      { role: "assistant", text: "hello", at: "2026-09-23T08:00:05Z" },
    ]);
    const bare = toTranscript([{ message_type: "assistant_message", content: "hello" }]).map(fromHistory);
    expect(bare).toEqual([{ role: "assistant", text: "hello" }]);
    expect("at" in bare[0]).toBe(false);
  });
});

describe("live rows are stamped on arrival", () => {
  test("user, tool, event and settled assistant rows carry the time they arrived; the reply keeps the time it started", () => {
    const l = emptyLive();
    applyEvent(l, delta("user_message", { content: "go" }), "2026-09-23T09:00:00.000Z");
    applyEvent(l, delta("assistant_message", { content: "Let " }), "2026-09-23T09:00:02.000Z");
    applyEvent(l, delta("assistant_message", { content: "me" }), "2026-09-23T09:00:03.000Z");
    expect(l.streamingAt).toBe("2026-09-23T09:00:02.000Z");
    applyEvent(l, delta("tool_call_message", { tool_call: { name: "Bash", tool_call_id: "t1" } }), "2026-09-23T09:00:04.000Z");
    beginCommand(l, "/reload", "2026-09-23T09:00:06.000Z");
    expect(l.tail.map((r) => [r.role, r.at])).toEqual([
      ["user", "2026-09-23T09:00:00.000Z"],
      ["assistant", "2026-09-23T09:00:02.000Z"],
      ["tool", "2026-09-23T09:00:04.000Z"],
      ["event", "2026-09-23T09:00:06.000Z"],
    ]);
    expect(l.streamingAt).toBeNull();
  });

  test("a reload from history keeps the live times where history has none, and history's own time wins", () => {
    const live: TranscriptRow[] = [
      { role: "user", text: "ok", at: "2026-09-23T09:00:00.000Z" },
      { role: "assistant", text: "done", at: "2026-09-23T09:00:02.000Z" },
    ];
    // the mod's log without times: an older "ok" must not take the newest one's time
    const reloaded = carryTimes([{ role: "user", text: "ok" }, { role: "assistant", text: "earlier" }, { role: "user", text: "ok" }, { role: "assistant", text: "done" }], live);
    expect(reloaded.map((r) => r.at)).toEqual([undefined, undefined, "2026-09-23T09:00:00.000Z", "2026-09-23T09:00:02.000Z"]);
    const withOwn = carryTimes([{ role: "user", text: "ok", at: "2026-09-23T08:59:59Z" }, { role: "assistant", text: "done" }], live);
    expect(withOwn.map((r) => r.at)).toEqual(["2026-09-23T08:59:59Z", "2026-09-23T09:00:02.000Z"]);
    // a second reload still finds the times in the rows the first one kept
    expect(carryTimes([{ role: "user", text: "ok" }, { role: "assistant", text: "done" }], reloaded).map((r) => r.at)).toEqual(["2026-09-23T09:00:00.000Z", "2026-09-23T09:00:02.000Z"]);
  });
});

describe("day pills", () => {
  const tz = process.env.TZ;
  afterEach(() => {
    process.env.TZ = tz;
  });
  const row = (at?: string): TranscriptRow => ({ role: "assistant", text: "x", at });

  test("a pill where the calendar day changes, in the user's time zone; untimed rows get none", () => {
    const now = Date.parse("2026-09-23T12:00:00Z");
    // 12:00 and 23:30 UTC on the 22nd, 00:30 UTC on the 23rd
    const rows = [row("2026-09-22T12:00:00Z"), row(), row("2026-09-22T23:30:00Z"), row("2026-09-23T00:30:00Z")];
    process.env.TZ = "UTC";
    expect(dayPills(rows, now)).toEqual(["Yesterday", null, null, "Today"]);
    process.env.TZ = "Asia/Kolkata"; // +5:30: 23:30 UTC is already the 23rd
    expect(dayPills(rows, now)).toEqual(["Yesterday", null, "Today", null]);
    process.env.TZ = "America/Los_Angeles"; // -7: all three fall on the 22nd
    expect(dayPills(rows, now)).toEqual(["Yesterday", null, null, null]);
    expect(dayPills([row(), row()], now)).toEqual([null, null]);
  });

  test("the time on an author row reads in the user's locale", () => {
    const at = new Date(2026, 8, 23, 10, 42).toISOString();
    expect(clockLabel(at)).toBe(new Date(at).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }));
    expect(clockLabel(undefined)).toBeNull();
    expect(clockLabel("nope")).toBeNull();
  });
});

describe("the New line", () => {
  const seen = "2026-09-23T09:00:00Z";
  test("with times, it sits before the first assistant message after you last looked", () => {
    const rows: TranscriptRow[] = [
      { role: "assistant", text: "old", at: "2026-09-23T08:00:00Z" },
      { role: "user", text: "q", at: "2026-09-23T08:30:00Z" },
      { role: "assistant", text: "read", at: "2026-09-23T08:59:00Z" },
      { role: "tool", text: "Bash", at: "2026-09-23T09:01:00Z" },
      { role: "assistant", text: "new", at: "2026-09-23T09:02:00Z" },
      { role: "assistant", text: "newer", at: "2026-09-23T09:03:00Z" },
    ];
    expect(unreadBoundary(rows, true, seen)).toBe(4);
    expect(unreadBoundary(rows, false, seen)).toBeNull();
    // turn-based would have put it after your last message
    expect(unreadBoundary(rows, true)).toBe(2);
  });

  test("the streaming reply after read rows is the first unread one", () => {
    const rows: TranscriptRow[] = [{ role: "assistant", text: "read", at: "2026-09-23T08:59:00Z" }, { role: "assistant", text: "streaming" }];
    expect(unreadBoundary(rows, true, seen)).toBe(1);
  });

  test("unread, but every timed row is at or before seenAt (stamped mid-stream): the turn rule, not no line", () => {
    const rows: TranscriptRow[] = [
      { role: "user", text: "q", at: "2026-09-23T08:30:00Z" },
      { role: "assistant", text: "a", at: "2026-09-23T08:40:00Z" },
      { role: "assistant", text: "b", at: "2026-09-23T08:59:00Z" },
    ];
    expect(unreadBoundary(rows, true, seen)).toBe(1);
    expect(unreadBoundary(rows, false, seen)).toBeNull();
  });

  test("without times it falls back to the phone's turn-based rule", () => {
    const rows: TranscriptRow[] = [{ role: "assistant", text: "a" }, { role: "user", text: "q" }, { role: "assistant", text: "b" }];
    expect(unreadBoundary(rows, true, seen)).toBe(2);
    // untimed history under timed live rows: nothing proves the old rows were read, so the turn rule stands
    const mixed: TranscriptRow[] = [{ role: "assistant", text: "a" }, { role: "user", text: "q" }, { role: "assistant", text: "b" }, { role: "assistant", text: "c", at: "2026-09-23T09:05:00Z" }];
    expect(unreadBoundary(mixed, true, seen)).toBe(2);
  });
});

describe("the New line after a look", () => {
  const seen = "2026-09-23T09:00:00Z";
  const rows: TranscriptRow[] = [
    { role: "user", text: "q", at: "2026-09-23T08:30:00Z" },
    { role: "assistant", text: "a", at: "2026-09-23T09:02:00Z" },
    { role: "assistant", text: "b", at: "2026-09-23T09:10:00Z" },
    { role: "assistant", text: "c", at: "2026-09-23T09:20:00Z" },
  ];
  test("it sits before what came since the last look, when the look is newer than done", () => {
    expect(unreadBoundary(rows, true, seen)).toBe(1);
    expect(unreadBoundary(rows, true, seen, "2026-09-23T09:15:00Z")).toBe(3);
    // looked at everything: no line, though it is not done
    expect(unreadBoundary(rows, true, seen, "2026-09-23T09:30:00Z")).toBeNull();
    // done is still the gate
    expect(unreadBoundary(rows, false, seen, "2026-09-23T09:15:00Z")).toBeNull();
  });
  test("a look older than done, or none, leaves the done rule; untimed rows fall back to it too", () => {
    expect(unreadBoundary(rows, true, seen, "2026-09-23T08:45:00Z")).toBe(1);
    expect(unreadBoundary(rows, true, seen, null)).toBe(1);
    expect(unreadBoundary(rows, true, null, "2026-09-23T09:15:00Z")).toBe(3);
    const untimed: TranscriptRow[] = [{ role: "user", text: "q" }, { role: "assistant", text: "a" }];
    expect(unreadBoundary(untimed, true, seen, "2026-09-23T09:15:00Z")).toBe(1);
  });
  test("holdMark: the look from before this open is held while the desk stays open, dropped when it closes", () => {
    const open = holdMark(null, "a/c", { viewedAt: "2026-09-23T09:15:00Z" });
    expect(open).toEqual({ key: "a/c", mark: "2026-09-23T09:15:00Z" });
    // this open's own stamp arrives: the held mark does not move, so the line stays
    expect(holdMark(open, "a/c", { viewedAt: "2026-09-23T09:40:00Z" })).toBe(open);
    // the item blinks out on a reload: still held
    expect(holdMark(open, "a/c", null)).toBe(open);
    // closed, then another desk; nothing to hold before its item is known
    expect(holdMark(open, null, { viewedAt: "x" })).toBeNull();
    expect(holdMark(open, "a/d", null)).toBeNull();
    expect(holdMark(open, "a/d", { viewedAt: null })).toEqual({ key: "a/d", mark: null });
  });
});

describe("the mod's local history", () => {
  test("rows carry the log line's timestamp; lines without one give rows without", async () => {
    const { mkdirSync, mkdtempSync, rmSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { readLocalTranscript } = await import("../mod/desks.ts");
    const { conversationDirName } = await import("../core/desk-core.ts");
    const backend = mkdtempSync(join(tmpdir(), "loki-backend-"));
    try {
      const dir = join(backend, "conversations", conversationDirName("local-conv-t"));
      mkdirSync(dir, { recursive: true });
      const lines = [
        { type: "message", timestamp: "2026-09-22T17:48:21.948Z", message: { role: "user", content: "hi" } },
        { type: "message", message: { role: "assistant", content: [{ type: "text", text: "hello" }, { type: "toolCall", name: "Bash", arguments: {} }], metadata: { created_at: "2026-09-22T17:48:30.000Z" } } },
        { type: "message", message: { role: "user", content: "untimed" } },
      ];
      writeFileSync(join(dir, "messages.jsonl"), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
      expect(readLocalTranscript("local-conv-t", null, 400, backend)).toEqual([
        { role: "user", text: "hi", at: "2026-09-22T17:48:21.948Z" },
        { role: "assistant", text: "hello", at: "2026-09-22T17:48:30.000Z" },
        { role: "tool", text: "Bash", at: "2026-09-22T17:48:30.000Z" },
        { role: "user", text: "untimed" },
      ]);
    } finally {
      rmSync(backend, { recursive: true, force: true });
    }
  });
});

describe("Transcript draws the times in the message layout only", () => {
  const today = new Date();
  today.setHours(10, 42, 0, 0);
  const yesterday = new Date(today.getTime() - 86_400_000);
  const rows: TranscriptRow[] = [
    { role: "user", text: "old", at: yesterday.toISOString() },
    { role: "assistant", text: "reply", at: yesterday.toISOString() },
    { role: "assistant", text: "fresh", at: today.toISOString() },
    { role: "assistant", text: "untimed" },
  ];
  const people = { user: { name: "You" }, assistant: { name: "ira" } };

  test("author rows show their time, each day opens with a pill, and the New line leaves the day to the pills", () => {
    const html = renderToStaticMarkup(createElement(Transcript, { rows, people, dividerAt: 2, dividerDay: "Today" }));
    expect(html.match(/class="loki-msg-day-pill"/g)?.length).toBe(2);
    expect(html).toContain(">Yesterday</span>");
    expect(html).toContain(">Today</span>");
    expect(html.match(/<time class="loki-msg-time"/g)?.length).toBe(3); // a new day starts a new run: "fresh" names its author again
    expect(html).toContain(clockLabel(today.toISOString())!);
    expect(html).not.toContain("loki-msg-divider-day");
    expect(html).toContain("loki-msg-divider-new");
  });

  test("a widget row sits under its own day's pill, and a day with only widget rows gets one", () => {
    const late = new Date(today);
    late.setDate(late.getDate() - 1);
    late.setHours(23, 50, 0, 0);
    const early = new Date(today);
    early.setHours(0, 10, 0, 0);
    const mark = (id: string, at: Date, before: number) => ({ id, before, at: at.toISOString(), who: "ira", change: "added" as const, title: `w-${id}`, widgetId: `d/${id}`, gone: false });
    const timed: TranscriptRow[] = [
      { role: "user", text: "old", at: yesterday.toISOString() },
      { role: "assistant", text: "morning", at: early.toISOString() },
    ];
    const html = renderToStaticMarkup(createElement(Transcript, { rows: timed, people, widgets: [mark("late", late, 1)] }));
    const at = (s: string) => html.indexOf(s);
    expect(at(">Yesterday</span>")).toBeLessThan(at("w-late"));
    expect(at("w-late")).toBeLessThan(at(">Today</span>"));
    expect(at(">Today</span>")).toBeLessThan(at("morning"));
    // yesterday's messages, then a widget change today and nothing else: today still gets its pill
    const only = renderToStaticMarkup(createElement(Transcript, { rows: timed.slice(0, 1), people, widgets: [mark("now", today, 1)] }));
    expect(only.match(/class="loki-msg-day-pill"/g)?.length).toBe(2);
    expect(only.indexOf(">Today</span>")).toBeLessThan(only.indexOf("w-now"));
  });

  test("untimed rows keep today's look: no pills, no times, the New line's own day", () => {
    const bare = rows.map(({ at: _at, ...r }) => r);
    const html = renderToStaticMarkup(createElement(Transcript, { rows: bare, people, dividerAt: 2, dividerDay: "Today" }));
    expect(html).not.toContain("loki-msg-day");
    expect(html).not.toContain("loki-msg-time");
    expect(html).toContain('<span class="loki-msg-divider-day">Today</span>');
  });

  test("without the layout the bubbles carry no times", () => {
    const html = renderToStaticMarkup(createElement(Transcript, { rows }));
    expect(html).not.toContain("loki-msg");
    expect(html).toContain("loki-bubble");
  });
});
