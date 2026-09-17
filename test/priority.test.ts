import { describe, expect, test } from "bun:test";
import type { AttentionItem } from "../core/attention/model.ts";
import { AGE_POINTS_PER_HOUR, BLOCKED_POINTS, WAITING_POINTS_PER_HOUR, WARM_MS, WARM_POINTS, YOURS_POINTS, byScore, reasonOf, scoreOf, scored } from "../core/attention/priority.ts";
import { isScheduledPrompt } from "../core/harness.ts";
import { attentionItem } from "./fixtures/attention.ts";

/**
 * The inbox's score (core/attention/priority.ts): one number per card, one list. Blocked agents on
 * top, then warm replies to you, then colder ones, then reports; age only breaks ties and drifts down.
 */

const NOW = new Date("2026-09-16T10:00:00Z").getTime();
const at = (minutesAgo: number) => new Date(NOW - minutesAgo * 60_000).toISOString();
const item = (id: string, over: Partial<AttentionItem> = {}) => attentionItem(id, { lastMessageAt: at(60), ...over });

describe("the score", () => {
  test("blocked dwarfs everything: an approval, a question, a failure each score 100 before age", () => {
    for (const status of ["approval", "question", "failed"] as const) {
      expect(scoreOf(item("b", { status, lastMessageAt: at(30) }), NOW)).toBeCloseTo(BLOCKED_POINTS + WAITING_POINTS_PER_HOUR / 2, 5);
    }
    // blocked and warm both: the terms add
    expect(scoreOf(item("b", { status: "approval", lastMessageAt: at(1) }), NOW)).toBeCloseTo(BLOCKED_POINTS + WARM_POINTS + WAITING_POINTS_PER_HOUR / 60, 5);
    // among blocked cards the one that has waited longest comes first
    expect(scored([item("new", { status: "approval", lastMessageAt: at(6) }), item("old", { status: "approval", lastMessageAt: at(50) })], NOW).map((i) => i.id)).toEqual(["old", "new"]);
    // …unless the newer one is still warm: answering it now is cheap, and the terms add
    expect(scored([item("new", { status: "approval", lastMessageAt: at(2) }), item("old", { status: "approval", lastMessageAt: at(50) })], NOW).map((i) => i.id)).toEqual(["new", "old"]);
    // a day-old approval still beats a warm reply that just landed
    expect(scoreOf(item("b", { status: "approval", lastMessageAt: at(24 * 60) }), NOW)).toBeGreaterThan(scoreOf(item("w", { lastMessageAt: at(0), lastAsk: "person" }), NOW));
  });

  test("warm: the agent spoke under four minutes ago, the provider's cache is still hot", () => {
    expect(scoreOf(item("w", { lastMessageAt: at(3) }), NOW)).toBeCloseTo(WARM_POINTS - AGE_POINTS_PER_HOUR * 0.05, 5);
    expect(scoreOf(item("c", { lastMessageAt: new Date(NOW - WARM_MS).toISOString() }), NOW)).toBeCloseTo(-AGE_POINTS_PER_HOUR * (WARM_MS / 3_600_000), 5);
    expect(reasonOf(item("w", { lastMessageAt: at(3) }), NOW)).toBe("warm");
  });

  test("yours: the turn answered a person; a scheduled prompt makes it a report", () => {
    const yours = item("y", { lastAsk: "person" });
    const cron = item("r", { lastAsk: "schedule" });
    const unknown = item("u");
    expect(scoreOf(yours, NOW)).toBeCloseTo(YOURS_POINTS - AGE_POINTS_PER_HOUR, 5);
    expect(scoreOf(cron, NOW)).toBeCloseTo(-AGE_POINTS_PER_HOUR, 5);
    expect(scoreOf(unknown, NOW)).toBeCloseTo(-AGE_POINTS_PER_HOUR, 5);
    expect(reasonOf(yours, NOW)).toBe("reply");
    expect(reasonOf(cron, NOW)).toBe("report");
    // the person spoke last (the agent has not answered yet): not a reply to you
    expect(scoreOf(item("p", { lastRole: "user", lastAsk: "person" }), NOW)).toBeCloseTo(-AGE_POINTS_PER_HOUR, 5);
  });

  test("age drifts a card down, a tenth of a point an hour; only a blocked card ages upward", () => {
    const fresh = item("f", { lastMessageAt: at(30) });
    const stale = item("s", { lastMessageAt: at(3 * 24 * 60) });
    expect(scoreOf(fresh, NOW)).toBeGreaterThan(scoreOf(stale, NOW));
    expect(scoreOf(stale, NOW)).toBeCloseTo(-AGE_POINTS_PER_HOUR * 72, 5);
    // a reply to you from yesterday still outranks a report from an hour ago
    expect(scoreOf(item("y", { lastMessageAt: at(20 * 60), lastAsk: "person" }), NOW)).toBeGreaterThan(scoreOf(item("r", { lastMessageAt: at(60), lastAsk: "schedule" }), NOW));
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
  test("scored stamps score and reason at one instant, highest first; ties keep their incoming order", () => {
    const report = item("report", { lastMessageAt: at(10), lastAsk: "schedule" });
    const cold = item("cold", { lastMessageAt: at(6 * 60), lastAsk: "person" });
    const warm = item("warm", { lastMessageAt: at(2), lastAsk: "person" });
    const blocked = item("blocked", { status: "question", pendingQuestion: { requestId: "q", input: {}, questions: [], at: at(30) }, lastMessageAt: at(30) });
    const tie1 = item("tie1", { lastMessageAt: at(60) });
    const tie2 = item("tie2", { lastMessageAt: at(60) });
    const list = scored([tie1, report, cold, warm, tie2, blocked], NOW);
    expect(list.map((i) => i.id)).toEqual(["blocked", "warm", "cold", "report", "tie1", "tie2"]);
    expect(list.map((i) => i.reason)).toEqual(["blocked", "warm", "reply", "report", "report", "report"]);
    expect(list[0].score).toBeGreaterThan(BLOCKED_POINTS);
    // byScore orders by the stamp alone, so a later re-sort reads the same instant the items were built at
    expect(byScore([list[3], list[1], list[0]]).map((i) => i.id)).toEqual(["blocked", "warm", "report"]);
  });

  test("does not mutate its input", () => {
    const list = [item("a", { lastMessageAt: at(60) }), item("b", { lastMessageAt: at(1) })];
    scored(list, NOW);
    expect(list.map((i) => i.id)).toEqual(["a", "b"]);
  });
});
