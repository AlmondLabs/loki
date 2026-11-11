import { describe, expect, test } from "vitest";
import type { OutsideMessage, OutsideWindow } from "../core/frame-types.ts";
import { refreshAsk, withNewer, type Shown } from "../app/src/desk/outside-card.tsx";
import { atBottom } from "../app/src/desk/slack-thread.tsx";

const msg = (id: string, extra: Partial<OutsideMessage> = {}): OutsideMessage => ({ id, sender: "Ada", at: "", text: `at ${id}`, mine: false, ...extra });
const channel: OutsideWindow = { view: "channel", thread_ts: null, more_before: true, more_after: false };
const thread: OutsideWindow = { view: "thread", thread_ts: "100.000001", more_before: 0, more_after: 0 };
const shown = (messages: OutsideMessage[], window: OutsideWindow): Shown => ({
  view: "v",
  tag: "v",
  messages,
  window,
  busy: null,
  failed: null,
  link: null,
  ticket: null,
});

describe("a Slack card keeps its view while new messages come (plan 090)", () => {
  test("a channel or DM reads on from the last message shown, in the channel view", () => {
    expect(refreshAsk([msg("100.000001"), msg("100.000002")], channel)).toEqual({ view: "channel", direction: "after", from: "100.000002" });
  });
  test("a thread, the card's own or one opened on it, is read whole in that thread", () => {
    expect(refreshAsk([msg("100.000001")], thread)).toEqual({ view: "thread", thread_ts: "100.000001" });
  });
  test("a channel with more after what was loaded reads nothing: load later reaches the new message", () => {
    expect(refreshAsk([msg("100.000001")], { ...channel, more_after: true })).toBeNull();
    expect(refreshAsk([], channel)).toBeNull();
  });

  test("newer messages go at the end; the rows above, their New line and mention look, stay as drawn", () => {
    const now = shown([msg("100.000001", { unread: true, brought: true }), msg("100.000002")], channel);
    const out = { messages: [msg("100.000003"), msg("100.000004")], window: { ...channel, more_after: false } };
    const next = withNewer(now, out);
    expect(next.messages.map((m) => m.id)).toEqual(["100.000001", "100.000002", "100.000003", "100.000004"]);
    expect(next.messages[0]).toEqual(now.messages[0]);
    expect(next.window).toEqual(channel);
  });
  test("a thread read whole adds only its newer replies and takes the shown ones' reactions, not their marks", () => {
    const root = msg("100.000001");
    const now = shown([root, msg("100.000005", { unread: true })], thread);
    const thumbs = [{ name: "+1", count: 1, mine: false, emoji: null }];
    const out = {
      messages: [root, msg("100.000002"), msg("100.000005", { reactions: thumbs }), msg("100.000009")],
      window: thread,
    };
    const next = withNewer(now, out);
    expect(next.messages.map((m) => m.id)).toEqual(["100.000001", "100.000005", "100.000009"]);
    expect(next.messages[1]).toEqual({ ...now.messages[1], reactions: thumbs });
  });
  test("ordering compares Slack times as times, not as text", () => {
    const now = shown([msg("99.900000")], channel);
    const next = withNewer(now, { messages: [msg("100.000001")], window: channel });
    expect(next.messages.map((m) => m.id)).toEqual(["99.900000", "100.000001"]);
  });
  test("a thread with replies after what was loaded keeps the gap and counts the new ones in it", () => {
    const now = shown([msg("100.000001"), msg("100.000002")], { ...thread, more_after: 3 });
    const out = {
      messages: [msg("100.000001"), msg("100.000002"), msg("100.000003"), msg("100.000004"), msg("100.000005"), msg("100.000006")],
      window: thread,
    };
    const next = withNewer(now, out);
    expect(next.messages.map((m) => m.id)).toEqual(["100.000001", "100.000002"]);
    expect(next.window?.more_after).toBe(4);
  });

  test("the box counts as at the bottom within a row's worth of the end", () => {
    expect(atBottom({ scrollHeight: 1000, scrollTop: 600, clientHeight: 400 })).toBe(true);
    expect(atBottom({ scrollHeight: 1000, scrollTop: 580, clientHeight: 400 })).toBe(true);
    expect(atBottom({ scrollHeight: 1000, scrollTop: 500, clientHeight: 400 })).toBe(false);
  });
});
