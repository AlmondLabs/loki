import { describe, expect, test } from "vitest";
import {
  DEFAULT_GOALS_SETTINGS,
  attentionGoalsCount,
  defaultCadenceFor,
  goalDiscoveryBrief,
  goalHealth,
  goalNeedsNudge,
  goalPulseBrief,
  goalWorkBrief,
  isInQuietHours,
  isoDateInZone,
  isoWeekKey,
  weeklyHabitProgress,
  type Goal,
} from "../core/goals.ts";

function makeGoal(over: Partial<Goal> = {}): Goal {
  return {
    id: "goal-1",
    title: "Ship v1",
    horizon: "short",
    status: "active",
    why: "Get 10 early users",
    obstacle: "Urgent inbox threads",
    fallback_plan: "Block 9-10:30 AM before checking Slack",
    parent_id: null,
    agent_id: null,
    target_date: null,
    progress: null,
    next_step: "Send invite to 3 testers",
    lead_habit: null,
    cadence: "daily",
    chat_id: null,
    entries: [],
    last_touched_at: "2026-11-28T09:00:00.000Z",
    last_nudged_at: null,
    created_at: "2026-11-20T09:00:00.000Z",
    updated_at: "2026-11-28T09:00:00.000Z",
    ...over,
  };
}

describe("core/goals: health, quiet hours, and cadences", () => {
  const NOW = Date.parse("2026-11-28T12:00:00.000Z");

  test("defaultCadenceFor matches horizon", () => {
    expect(defaultCadenceFor("short")).toBe("daily");
    expect(defaultCadenceFor("medium")).toBe("weekly");
    expect(defaultCadenceFor("long")).toBe("monthly");
  });

  test("goalHealth distinguishes moving, quiet, and at_risk calmly across horizons", () => {
    expect(goalHealth(makeGoal({ horizon: "short", last_touched_at: "2026-11-28T08:00:00.000Z" }), NOW).state).toBe("moving");
    expect(goalHealth(makeGoal({ horizon: "short", last_touched_at: "2026-11-25T08:00:00.000Z" }), NOW)).toMatchObject({
      state: "quiet",
      label: "Quiet for 3d",
    });
    expect(goalHealth(makeGoal({ horizon: "medium", last_touched_at: "2026-11-23T08:00:00.000Z" }), NOW).state).toBe("moving");
    expect(goalHealth(makeGoal({ horizon: "medium", last_touched_at: "2026-11-18T08:00:00.000Z" }), NOW).state).toBe("quiet");
    expect(goalHealth(makeGoal({ target_date: "2026-11-27" }), NOW)).toMatchObject({ state: "at_risk", label: "Target passed" });
    expect(goalHealth(makeGoal({ target_date: "2026-11-29", last_touched_at: "2026-11-26T08:00:00.000Z" }), NOW)).toMatchObject({
      state: "at_risk",
      label: "Due soon",
    });
    expect(goalHealth(makeGoal({ status: "suggested" }), NOW).state).toBe("suggested");
  });

  test("attentionGoalsCount counts suggested goals plus quiet or at_risk active goals", () => {
    const goals = [
      makeGoal({ id: "g1", status: "active", last_touched_at: "2026-11-28T09:00:00.000Z" }),
      makeGoal({ id: "g2", status: "active", last_touched_at: "2026-11-24T09:00:00.000Z" }),
      makeGoal({ id: "g3", status: "suggested" }),
      makeGoal({ id: "g4", status: "achieved" }),
    ];
    expect(attentionGoalsCount(goals, NOW)).toBe(2);
  });

  test("weeklyHabitProgress counts check-ins in the Monday-Sunday window", () => {
    const now = new Date("2026-11-28T10:00:00.000Z");
    const progress = weeklyHabitProgress({ label: "Deep work", per_week: 4, checkins: ["2026-11-20", "2026-11-23", "2026-11-25", "2026-11-28"] }, now, "UTC");
    expect(progress.done).toBe(3);
    expect(progress.target).toBe(4);
    expect(progress.days).toHaveLength(7);
    expect(progress.days[0]).toMatchObject({ day: "2026-11-23", label: "M", done: true });
    expect(progress.days[5]).toMatchObject({ day: "2026-11-28", label: "S", done: true, today: true });
  });

  test("isInQuietHours handles overnight wraparound and same-day ranges", () => {
    const settings = { quiet_start: 21, quiet_end: 8, timezone: "UTC" };
    expect(isInQuietHours(new Date("2026-11-28T22:00:00.000Z"), settings)).toBe(true);
    expect(isInQuietHours(new Date("2026-11-28T07:00:00.000Z"), settings)).toBe(true);
    expect(isInQuietHours(new Date("2026-11-28T10:00:00.000Z"), settings)).toBe(false);
    expect(isInQuietHours(new Date("2026-11-28T14:00:00.000Z"), { quiet_start: 13, quiet_end: 15, timezone: "UTC" })).toBe(true);
  });

  test("goalNeedsNudge enforces enabled, off cadence, and cooldown", () => {
    const now = new Date("2026-11-28T10:00:00.000Z");
    const g = makeGoal({ last_nudged_at: "2026-11-28T02:00:00.000Z" });
    expect(goalNeedsNudge(g, DEFAULT_GOALS_SETTINGS, now)).toBe(false);
    expect(goalNeedsNudge(makeGoal({ last_nudged_at: "2026-11-27T08:00:00.000Z" }), DEFAULT_GOALS_SETTINGS, now)).toBe(true);
    expect(goalNeedsNudge(makeGoal({ cadence: "off" }), DEFAULT_GOALS_SETTINGS, now)).toBe(false);
    expect(goalNeedsNudge(makeGoal(), { ...DEFAULT_GOALS_SETTINGS, enabled: false }, now)).toBe(false);
  });

  test("isoDateInZone and isoWeekKey format reliably", () => {
    const d = new Date("2026-11-28T20:00:00.000Z");
    expect(isoDateInZone(d, "Asia/Kolkata")).toBe("2026-11-29");
    expect(isoWeekKey(new Date("2026-11-23T12:00:00.000Z"), "UTC")).toBe(isoWeekKey(new Date("2026-11-28T12:00:00.000Z"), "UTC"));
  });

  test("prompt builders include WOOP, WIP cap, and autonomy guidance", () => {
    const g = makeGoal();
    expect(goalDiscoveryBrief([g], "Ada")).toContain("Ada");
    expect(goalDiscoveryBrief([g], "Ada")).toContain("At most 3");
    expect(goalWorkBrief(g, null)).toContain("Block 9-10:30 AM");
    expect(goalPulseBrief({ kind: "weekly", goals: [g], allGoals: [g], autonomy: "prep_and_nudge", now: new Date(NOW) })).toContain("Wins first");
    expect(goalPulseBrief({ kind: "daily", goals: [g], allGoals: [g], autonomy: "nudge_only", now: new Date(NOW) })).toContain("2-minute");
  });
});
