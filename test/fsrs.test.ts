import { describe, expect, test } from "bun:test";
import { describeGap, intervalDays, isDue, isNew, keepsFailing, newSchedule, previews, retrievability, review } from "../packages/core/src/recall/fsrs.ts";
import { dueCount, reviewQueue, toAnkiTsv, updatedSinceReview, type Card, type CardWithSchedule } from "../packages/core/src/recall/model.ts";

const T0 = new Date("2026-09-10T09:00:00Z").getTime();
const DAY = 86_400_000;

describe("fsrs", () => {
  test("a new card is due now and unreviewed", () => {
    const s = newSchedule(T0);
    expect(isNew(s)).toBe(true);
    expect(isDue(s, T0)).toBe(true);
    expect(retrievability(s, T0)).toBe(0);
  });
  test("the first answer sets the stability from the weights: harder answers, shorter gaps", () => {
    const gaps = ([1, 2, 3, 4] as const).map((g) => new Date(review(newSchedule(T0), g, T0).due).getTime() - T0);
    expect(gaps[0]).toBe(10 * 60_000); // again: back in the sitting
    expect(gaps[1]).toBeLessThan(gaps[2]);
    expect(gaps[2]).toBeLessThan(gaps[3]);
    expect(gaps[3]).toBeGreaterThanOrEqual(10 * DAY); // easy on first sight: about two weeks
  });
  test("good answers on time stretch the interval each round", () => {
    let s = review(newSchedule(T0), 3, T0);
    let now = T0;
    const intervals: number[] = [];
    for (let i = 0; i < 5; i++) {
      now = new Date(s.due).getTime(); // reviewed exactly when due
      const before = s.stability;
      s = review(s, 3, now);
      expect(s.stability).toBeGreaterThan(before);
      intervals.push((new Date(s.due).getTime() - now) / DAY);
    }
    for (let i = 1; i < intervals.length; i++) expect(intervals[i]).toBeGreaterThanOrEqual(intervals[i - 1]); // capped at a year
    expect(intervals[1]).toBeGreaterThan(intervals[0]);
    expect(s.reps).toBe(6);
    expect(s.lapses).toBe(0);
  });
  test("forgetting counts a lapse, drops stability and relearns within minutes", () => {
    let s = review(newSchedule(T0), 3, T0);
    for (let i = 0; i < 3; i++) s = review(s, 3, new Date(s.due).getTime());
    const learned = s.stability;
    const now = new Date(s.due).getTime();
    const after = review(s, 1, now);
    expect(after.lapses).toBe(1);
    expect(after.stability).toBeLessThan(learned);
    expect(new Date(after.due).getTime() - now).toBe(10 * 60_000);
    expect(after.difficulty).toBeGreaterThan(s.difficulty);
  });
  test("retrievability decays with time and the interval targets 90%", () => {
    const s = review(newSchedule(T0), 3, T0);
    expect(retrievability(s, T0)).toBeCloseTo(1, 5);
    const atDue = retrievability(s, new Date(s.due).getTime());
    expect(atDue).toBeGreaterThan(0.85);
    expect(atDue).toBeLessThan(0.95);
    expect(intervalDays(0.01)).toBe(1);
    expect(intervalDays(10_000)).toBe(365);
  });
  test("previews describe each grade's gap; gaps read as m, h, d, w, mo", () => {
    const p = previews(newSchedule(T0), T0);
    expect(p[1]).toBe("10m");
    expect(p[3]).toMatch(/^\d+d$/);
    expect(describeGap(30 * 60_000)).toBe("30m");
    expect(describeGap(5 * 3600_000)).toBe("5h");
    expect(describeGap(3 * DAY)).toBe("3d");
    expect(describeGap(21 * DAY)).toBe("3w");
    expect(describeGap(120 * DAY)).toBe("4mo");
  });
  test("a card that keeps failing is flagged after three agains in the last four", () => {
    let s = newSchedule(T0);
    s = review(s, 3, T0);
    expect(keepsFailing(s)).toBe(false);
    s = review(s, 1, T0 + DAY);
    s = review(s, 1, T0 + DAY + 600_000);
    expect(keepsFailing(s)).toBe(false);
    s = review(s, 1, T0 + DAY + 1_200_000);
    expect(keepsFailing(s)).toBe(true);
    s = review(s, 3, T0 + 2 * DAY);
    expect(keepsFailing(s)).toBe(true); // 1,1,1,3
    s = review(s, 3, T0 + 3 * DAY);
    expect(keepsFailing(s)).toBe(false); // 1,1,3,3
  });
});

const card = (id: string, over: Partial<Card> = {}): Card => ({
  id, front: `q ${id}`, back: `a ${id}`, tags: [], createdAt: "2026-09-10T08:00:00Z", updatedAt: "2026-09-10T08:00:00Z", updatedBy: "recall", previous: [],
  source: { agentId: "a", agentName: "ira", conversationId: "c", title: "main chat", at: null }, ...over,
});

describe("recall queue", () => {
  test("new cards first by creation, then due cards most overdue first; not-due cards stay out", () => {
    const later = new Date(T0 + DAY).toISOString();
    const rows: CardWithSchedule[] = [
      { card: card("due-late"), schedule: { ...review(newSchedule(T0 - 10 * DAY), 3, T0 - 10 * DAY), due: new Date(T0 - DAY).toISOString() } },
      { card: card("new-2", { createdAt: "2026-09-10T08:30:00Z" }), schedule: newSchedule(T0) },
      { card: card("due-very-late"), schedule: { ...review(newSchedule(T0 - 10 * DAY), 3, T0 - 10 * DAY), due: new Date(T0 - 3 * DAY).toISOString() } },
      { card: card("new-1", { createdAt: "2026-09-10T08:00:00Z" }), schedule: newSchedule(T0) },
      { card: card("tomorrow"), schedule: { ...review(newSchedule(T0), 3, T0), due: later } },
    ];
    expect(reviewQueue(rows, T0).map((r) => r.card.id)).toEqual(["new-1", "new-2", "due-very-late", "due-late"]);
    expect(dueCount(rows, T0)).toBe(4);
  });
  test("an update by the worker after the last review is flagged; the person's own edit is not", () => {
    const s = review(newSchedule(T0), 3, T0);
    const prev = [{ front: "old", back: "old", at: "2026-09-10T08:00:00Z", by: "recall" as const }];
    expect(updatedSinceReview({ card: card("x", { previous: prev, updatedAt: new Date(T0 + DAY).toISOString() }), schedule: s })).toBe(true);
    expect(updatedSinceReview({ card: card("x", { previous: prev, updatedAt: "2026-09-10T08:30:00Z" }), schedule: s })).toBe(false);
    expect(updatedSinceReview({ card: card("x", { previous: prev, updatedBy: "you", updatedAt: new Date(T0 + DAY).toISOString() }), schedule: s })).toBe(false);
    expect(updatedSinceReview({ card: card("x"), schedule: newSchedule(T0) })).toBe(false); // never edited
  });
  test("anki export: front TAB back TAB tags, newlines as <br>", () => {
    const rows: CardWithSchedule[] = [{ card: card("1", { front: "What\tis X?", back: "line 1\nline 2", tags: ["aws", "iam"] }), schedule: newSchedule(T0) }];
    expect(toAnkiTsv(rows)).toBe("What is X?\tline 1<br>line 2\taws iam\n");
    expect(toAnkiTsv([])).toBe("");
  });
});
