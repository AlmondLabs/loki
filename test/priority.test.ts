import { describe, expect, test } from "vitest";
import type { AttentionItem } from "../core/attention/model.ts";
import { AGE_POINTS_PER_HOUR, BLOCKED_POINTS, FOCUS_POINTS, NEW_POINTS, WAITING_POINTS_PER_HOUR, byScore, reasonOf, scoreOf, scored } from "../core/attention/priority.ts";
import { isScheduledPrompt } from "../core/harness.ts";
import { attentionItem } from "./fixtures/attention.ts";

/**
 * The inbox's score (core/attention/priority.ts): one number per card, one list. Blocked agents on top, then
 * the chats you have been engaging with (their focus share), then the rest; age only drifts cards down.
 */

const NOW = new Date("2026-09-16T10:00:00Z").getTime();
const at = (minutesAgo: number) => new Date(NOW - minutesAgo * 60_000).toISOString();
// read by default: "new" is its own term, tested on its own
const item = (id: string, over: Partial<AttentionItem> = {}) => attentionItem(id, { lastMessageAt: at(60), unread: false, ...over });

describe("the score", () => {
  test("blocked dwarfs everything: an approval or a question scores 100 before age; a failed turn is not blocked", () => {
    for (const status of ["approval", "question"] as const) {
      expect(scoreOf(item("b", { status, lastMessageAt: at(30) }), NOW)).toBeCloseTo(BLOCKED_POINTS + WAITING_POINTS_PER_HOUR / 2, 5);
    }
    expect(scoreOf(item("f", { status: "failed", lastMessageAt: at(30) }), NOW)).toBeCloseTo(-AGE_POINTS_PER_HOUR / 2, 5);
    // among blocked cards the one that has waited longest comes first
    expect(scored([item("new", { status: "approval", lastMessageAt: at(6) }), item("old", { status: "approval", lastMessageAt: at(50) })], NOW).map((i) => i.id)).toEqual(["old", "new"]);
    // a day-old approval in a chat you left still beats the chat with all your focus
    expect(scoreOf(item("b", { status: "approval", lastMessageAt: at(24 * 60) }), NOW, 0)).toBeGreaterThan(scoreOf(item("f", { lastMessageAt: at(0) }), NOW, 1));
  });

  test("new: the agent said something since you last looked, +10; a blocked card does not add it", () => {
    expect(scoreOf(item("n", { unread: true, lastMessageAt: at(0) }), NOW)).toBeCloseTo(NEW_POINTS, 5);
    expect(reasonOf(item("n", { unread: true }))).toBe("new");
    // focus worth more than new names the card by its focus
    expect(reasonOf(item("n", { unread: true }), 0.8)).toBe("focus");
    expect(scoreOf(item("b", { status: "question", unread: true, lastMessageAt: at(0) }), NOW)).toBeCloseTo(BLOCKED_POINTS, 5);
    // a new card from a chat you have left outranks a read one in the chat you are working in, until focus passes 2/3
    expect(scoreOf(item("n", { unread: true }), NOW, 0)).toBeGreaterThan(scoreOf(item("r"), NOW, 0.6));
  });

  test("focus: the chat's share of your engagement, worth up to 15 points", () => {
    expect(scoreOf(item("f", { lastMessageAt: at(0) }), NOW, 0.5)).toBeCloseTo(FOCUS_POINTS / 2, 5);
    expect(reasonOf(item("f"), 0.5)).toBe("focus");
    // a sliver of focus does not earn the word
    expect(reasonOf(item("s"), 0.1)).toBe("other");
    expect(reasonOf(item("b", { status: "question" }), 0.9)).toBe("blocked");
  });

  test("age drifts a card down, a tenth of a point an hour; only a blocked card ages upward", () => {
    const fresh = item("f", { lastMessageAt: at(30) });
    const stale = item("s", { lastMessageAt: at(3 * 24 * 60) });
    expect(scoreOf(fresh, NOW)).toBeGreaterThan(scoreOf(stale, NOW));
    expect(scoreOf(stale, NOW)).toBeCloseTo(-AGE_POINTS_PER_HOUR * 72, 5);
    // a card from yesterday in the chat you are working in outranks a fresh one from a chat you have left
    expect(scoreOf(item("y", { lastMessageAt: at(20 * 60) }), NOW, 0.4)).toBeGreaterThan(scoreOf(item("r", { lastMessageAt: at(10) }), NOW, 0));
    expect(scoreOf(item("n", { lastMessageAt: null }), NOW)).toBe(0);
  });

  test("the scheduler's opening line is what marks a scheduled prompt", () => {
    expect(isScheduledPrompt('Scheduled task "jira-watch-daily" is firing.\nDescription: …')).toBe(true);
    expect(isScheduledPrompt("  Scheduled task x is firing")).toBe(true);
    expect(isScheduledPrompt("the scheduled task ran?")).toBe(false);
    expect(isScheduledPrompt("Scheduledtask")).toBe(false);
  });
});

describe("the order", () => {
  test("scored stamps score, reason and focus at one instant, highest first; ties keep their incoming order", () => {
    const quiet = item("quiet", { lastMessageAt: at(10) });
    const focused = item("focused", { lastMessageAt: at(6 * 60) });
    const blocked = item("blocked", { status: "question", pendingQuestion: { requestId: "q", input: {}, questions: [], at: at(30) }, lastMessageAt: at(30) });
    const tie1 = item("tie1", { lastMessageAt: at(60) });
    const tie2 = item("tie2", { lastMessageAt: at(60) });
    const list = scored([tie1, quiet, focused, tie2, blocked], NOW, { "a1/focused": 0.6 });
    expect(list.map((i) => i.id)).toEqual(["blocked", "focused", "quiet", "tie1", "tie2"]);
    expect(list.map((i) => i.reason)).toEqual(["blocked", "focus", "other", "other", "other"]);
    expect(list[1].focus).toBe(0.6);
    expect(list[0].score).toBeGreaterThan(BLOCKED_POINTS);
    // byScore orders by the stamp alone, so a later re-sort reads the same instant the items were built at
    expect(byScore([list[2], list[1], list[0]]).map((i) => i.id)).toEqual(["blocked", "focused", "quiet"]);
  });

  test("does not mutate its input", () => {
    const list = [item("a", { lastMessageAt: at(60) }), item("b", { lastMessageAt: at(1) })];
    scored(list, NOW);
    expect(list.map((i) => i.id)).toEqual(["a", "b"]);
  });
});
