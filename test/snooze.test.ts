import { describe, expect, test } from "bun:test";
import type { AttentionItem } from "../core/attention/model.ts";
import { activeSnooze, formatIn, nextSnooze, ordinal } from "../core/attention/snooze.ts";
import { MAX_SNOOZE_MS, snoozeGapMs } from "../core/attention/ladder.ts";
import { attentionItem } from "./fixtures/attention.ts";
import { stampOf } from "../core/attention/queue.ts";

const T0 = new Date("2026-09-05T10:00:00").getTime(); // local time, mid-day
const item = (over: Partial<AttentionItem> = {}) => attentionItem("c", { agentId: "a", lastMessageAt: "2026-09-05T09:00:00Z", lastAssistantText: "here", runtime: { agent_id: "a", conversation_id: "c" }, ...over });

describe("snooze backoff", () => {
  test("each deferral today waits longer along the ladder: 10m, 30m, 1h30, 4h30, 13h30, then a day, and stays at a day", () => {
    // deferred over and over within the same day (the clock is held so no day boundary is crossed)
    let s = nextSnooze(undefined, "x", T0);
    const gaps = [new Date(s.until).getTime() - T0];
    for (let i = 1; i < 8; i++) {
      s = nextSnooze(s, "x", T0);
      gaps.push(new Date(s.until).getTime() - T0);
    }
    expect(gaps.slice(0, 6).map((g) => g / 60_000)).toEqual([10, 30, 90, 270, 810, 1440]);
    expect(gaps[6]).toBe(MAX_SNOOZE_MS);
    expect(gaps[7]).toBe(MAX_SNOOZE_MS);
    expect(s.skips).toBe(8);
  });

  test("the ladder is a setting: a shorter first step and a gentler growth, or the old 5m · 15m · 45m ladder", () => {
    const gentle = { firstMinutes: 2, growth: 2 };
    let s = nextSnooze(undefined, "x", T0, gentle);
    expect(new Date(s.until).getTime() - T0).toBe(2 * 60_000);
    s = nextSnooze(s, "x", T0, gentle);
    expect(new Date(s.until).getTime() - T0).toBe(4 * 60_000);
    const old = { firstMinutes: 5, growth: 3 };
    expect([1, 2, 3, 4, 5, 6].map((n) => snoozeGapMs(n, old) / 60_000)).toEqual([5, 15, 45, 135, 405, 1215]);
  });

  test("a new day starts the ladder over", () => {
    const yesterday = { skips: 4, until: "2026-09-04T23:00:00", stamp: "x", at: "2026-09-04T22:00:00" };
    const s = nextSnooze(yesterday, "x", T0);
    expect(s.skips).toBe(1);
    expect(new Date(s.until).getTime() - T0).toBe(snoozeGapMs(1));
  });

  test("a snooze hides the card until due, unless it moved on, is an approval, or the day changed", () => {
    const it = item();
    const s = nextSnooze(undefined, stampOf(it), T0);
    expect(activeSnooze(it, s, T0 + 60_000)).toEqual(s);
    expect(activeSnooze(it, s, T0 + snoozeGapMs(1))).toBeNull(); // due
    expect(activeSnooze(item({ lastAssistantText: "something new" }), s, T0 + 60_000)).toBeNull(); // moved on
    expect(activeSnooze(item({ status: "approval", pendingApproval: { requestId: "p", toolName: "Bash", input: {}, at: "" } }), s, T0 + 60_000)).toBeNull();
    expect(activeSnooze(it, s, new Date("2026-09-06T00:01:00").getTime())).toBeNull(); // next day
    expect(activeSnooze(it, undefined, T0)).toBeNull();
  });

  test("labels", () => {
    expect([1, 2, 3, 4, 11, 12, 13, 21, 22, 23].map(ordinal)).toEqual(["1st", "2nd", "3rd", "4th", "11th", "12th", "13th", "21st", "22nd", "23rd"]);
    expect(formatIn(new Date(T0 + 4 * 60_000).toISOString(), T0)).toBe("4m");
    expect(formatIn(new Date(T0 + 2 * 3_600_000).toISOString(), T0)).toBe("2h");
    expect(formatIn(new Date(T0 - 1).toISOString(), T0)).toBe("now");
  });
});
