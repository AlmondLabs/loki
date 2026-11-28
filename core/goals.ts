export type GoalHorizon = "short" | "medium" | "long";
export const GOAL_HORIZONS: readonly GoalHorizon[] = ["short", "medium", "long"];

export type GoalStatus = "suggested" | "active" | "paused" | "achieved" | "dropped";
export const GOAL_STATUSES: readonly GoalStatus[] = ["suggested", "active", "paused", "achieved", "dropped"];

export type GoalCadence = "daily" | "weekly" | "monthly" | "off";
export const GOAL_CADENCES: readonly GoalCadence[] = ["daily", "weekly", "monthly", "off"];

export type GoalHealthState = "moving" | "quiet" | "at_risk" | "paused" | "achieved" | "suggested" | "dropped";

export type GoalAutonomy = "prep_and_nudge" | "nudge_only";
export const GOAL_AUTONOMY_MODES: readonly GoalAutonomy[] = ["prep_and_nudge", "nudge_only"];

export type GoalProgressSource = "user" | "agent" | "reflection" | "pulse";

export const SHORT_TERM_WIP_LIMIT = 3;

export const GOAL_CHECKIN_CHAT_TITLE = "Goal Check-ins";

export interface GoalProgressEntry {
  id: string;
  at: string;
  note: string;
  source: GoalProgressSource;
  chat_id?: string | null;
  agent_id?: string | null;
}

export interface GoalLeadHabit {
  label: string;
  per_week: number;
  checkins: string[];
}

export interface Goal {
  id: string;
  title: string;
  horizon: GoalHorizon;
  status: GoalStatus;
  why: string | null;
  obstacle: string | null;
  fallback_plan: string | null;
  parent_id: string | null;
  agent_id: string | null;
  target_date: string | null;
  progress: string | null;
  next_step: string | null;
  lead_habit: GoalLeadHabit | null;
  cadence: GoalCadence;
  chat_id: string | null;
  entries: GoalProgressEntry[];
  last_touched_at: string | null;
  last_nudged_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface GoalsSettings {
  enabled: boolean;
  partner_agent_id: string | null;
  autonomy: GoalAutonomy;
  daily_hour: number;
  weekly_day: number;
  weekly_hour: number;
  quiet_start: number;
  quiet_end: number;
  timezone: string | null;
}

export interface GoalsPulseStatus {
  last_run_at: string | null;
  last_note: string | null;
  last_weekly_review_at: string | null;
  last_daily_check_at: string | null;
}

export interface GoalsSnapshot {
  goals: Goal[];
  settings: GoalsSettings;
  pulse: GoalsPulseStatus;
}

export const DEFAULT_GOALS_SETTINGS: GoalsSettings = {
  enabled: true,
  partner_agent_id: null,
  autonomy: "prep_and_nudge",
  daily_hour: 9,
  weekly_day: 1,
  weekly_hour: 9,
  quiet_start: 21,
  quiet_end: 8,
  timezone: null,
};

export const EMPTY_GOALS_PULSE: GoalsPulseStatus = {
  last_run_at: null,
  last_note: null,
  last_weekly_review_at: null,
  last_daily_check_at: null,
};

export const HORIZON_LABEL: Record<GoalHorizon, string> = {
  short: "Short-term",
  medium: "Medium-term",
  long: "Long-term",
};

export const CADENCE_LABEL: Record<GoalCadence, string> = {
  daily: "Daily",
  weekly: "Weekly",
  monthly: "Monthly",
  off: "Off",
};

export const STATUS_LABEL: Record<GoalStatus, string> = {
  suggested: "Suggested",
  active: "Active",
  paused: "Paused",
  achieved: "Achieved",
  dropped: "Dropped",
};

export function defaultCadenceFor(horizon: GoalHorizon): GoalCadence {
  switch (horizon) {
    case "short":
      return "daily";
    case "medium":
      return "weekly";
    case "long":
      return "monthly";
  }
}

export function isGoalHorizon(v: unknown): v is GoalHorizon {
  return v === "short" || v === "medium" || v === "long";
}

export function isGoalStatus(v: unknown): v is GoalStatus {
  return v === "suggested" || v === "active" || v === "paused" || v === "achieved" || v === "dropped";
}

export function isGoalCadence(v: unknown): v is GoalCadence {
  return v === "daily" || v === "weekly" || v === "monthly" || v === "off";
}

export function isGoalAutonomy(v: unknown): v is GoalAutonomy {
  return v === "prep_and_nudge" || v === "nudge_only";
}

const DAY_MS = 24 * 60 * 60_000;
const QUIET_DAYS: Record<GoalHorizon, number> = { short: 2, medium: 7, long: 21 };
const DUE_SOON_DAYS: Record<GoalHorizon, number> = { short: 2, medium: 7, long: 14 };

export interface GoalHealth {
  state: GoalHealthState;
  label: string;
  quietDays: number;
}

export function goalHealth(goal: Pick<Goal, "status" | "horizon" | "last_touched_at" | "created_at" | "target_date">, nowMs = Date.now()): GoalHealth {
  if (goal.status !== "active") {
    return { state: goal.status, label: STATUS_LABEL[goal.status], quietDays: 0 };
  }
  const touchedMs = Date.parse(goal.last_touched_at ?? goal.created_at);
  const quietDays = Number.isFinite(touchedMs) ? Math.max(0, Math.floor((nowMs - touchedMs) / DAY_MS)) : 0;

  if (goal.target_date) {
    const dueMs = Date.parse(`${goal.target_date}T23:59:59Z`);
    if (Number.isFinite(dueMs)) {
      if (dueMs < nowMs) {
        return { state: "at_risk", label: "Target passed", quietDays };
      }
      const daysLeft = Math.ceil((dueMs - nowMs) / DAY_MS);
      if (daysLeft <= DUE_SOON_DAYS[goal.horizon] && quietDays >= 1) {
        return { state: "at_risk", label: "Due soon", quietDays };
      }
    }
  }

  if (quietDays >= QUIET_DAYS[goal.horizon]) {
    return { state: "quiet", label: `Quiet for ${quietDays}d`, quietDays };
  }

  return { state: "moving", label: "Moving", quietDays };
}

export function attentionGoalsCount(goals: readonly Goal[], nowMs = Date.now()): number {
  let count = 0;
  for (const g of goals) {
    if (g.status === "suggested") {
      count += 1;
      continue;
    }
    if (g.status === "active") {
      const h = goalHealth(g, nowMs).state;
      if (h === "quiet" || h === "at_risk") count += 1;
    }
  }
  return count;
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

export interface LocalTimeParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  /** 0 = Sunday .. 6 = Saturday */
  weekday: number;
  date: string;
}

function resolvedTimezone(timezone?: string | null): string {
  return timezone?.trim() || Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

export function localTimeParts(now: Date, timezone?: string | null): LocalTimeParts {
  const tz = resolvedTimezone(timezone);
  let fmt: Intl.DateTimeFormat;
  try {
    fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      weekday: "short",
    });
  } catch {
    fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: "UTC",
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      weekday: "short",
    });
  }
  let year = 1970;
  let month = 1;
  let day = 1;
  let hour = 0;
  let minute = 0;
  let weekday = 0;
  for (const part of fmt.formatToParts(now)) {
    switch (part.type) {
      case "year":
        year = Number(part.value);
        break;
      case "month":
        month = Number(part.value);
        break;
      case "day":
        day = Number(part.value);
        break;
      case "hour":
        hour = Number(part.value) % 24;
        break;
      case "minute":
        minute = Number(part.value);
        break;
      case "weekday": {
        const idx = WEEKDAYS.indexOf(part.value as (typeof WEEKDAYS)[number]);
        if (idx >= 0) weekday = idx;
        break;
      }
    }
  }
  const pad = (n: number) => String(n).padStart(2, "0");
  return { year, month, day, hour, minute, weekday, date: `${year}-${pad(month)}-${pad(day)}` };
}

export function isoDateInZone(now: Date, timezone?: string | null): string {
  return localTimeParts(now, timezone).date;
}

export function isoWeekKey(now: Date, timezone?: string | null): string {
  const p = localTimeParts(now, timezone);
  const d = new Date(Date.UTC(p.year, p.month - 1, p.day));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((d.getTime() - yearStart.getTime()) / DAY_MS + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

export interface HabitDayView {
  day: string;
  label: string;
  done: boolean;
  today: boolean;
}

export interface WeeklyHabitProgress {
  done: number;
  target: number;
  days: HabitDayView[];
}

const MONDAY_FIRST = ["M", "T", "W", "T", "F", "S", "S"] as const;

export function weeklyHabitProgress(habit: GoalLeadHabit, now: Date, timezone?: string | null): WeeklyHabitProgress {
  const p = localTimeParts(now, timezone);
  const todayUtc = new Date(Date.UTC(p.year, p.month - 1, p.day));
  const offsetFromMonday = (p.weekday + 6) % 7;
  const mondayMs = todayUtc.getTime() - offsetFromMonday * DAY_MS;
  const checkins = new Set(habit.checkins);
  const days: HabitDayView[] = [];
  let done = 0;
  for (let i = 0; i < 7; i++) {
    const d = new Date(mondayMs + i * DAY_MS);
    const iso = d.toISOString().slice(0, 10);
    const hit = checkins.has(iso);
    if (hit) done += 1;
    days.push({ day: iso, label: MONDAY_FIRST[i], done: hit, today: iso === p.date });
  }
  return { done, target: habit.per_week, days };
}

export function isInQuietHours(now: Date, settings: Pick<GoalsSettings, "quiet_start" | "quiet_end" | "timezone">): boolean {
  const { quiet_start: start, quiet_end: end, timezone } = settings;
  if (start === end) return false;
  const { hour } = localTimeParts(now, timezone);
  if (start < end) return hour >= start && hour < end;
  return hour >= start || hour < end;
}

const CADENCE_COOLDOWN_MS: Record<Exclude<GoalCadence, "off">, number> = {
  daily: 20 * 60 * 60_000,
  weekly: 6 * DAY_MS,
  monthly: 25 * DAY_MS,
};

export function goalNeedsNudge(goal: Goal, settings: GoalsSettings, now: Date): boolean {
  if (!settings.enabled || goal.status !== "active" || goal.cadence === "off") return false;
  const nowMs = now.getTime();
  if (goal.last_nudged_at) {
    const lastMs = Date.parse(goal.last_nudged_at);
    if (Number.isFinite(lastMs) && nowMs - lastMs < CADENCE_COOLDOWN_MS[goal.cadence]) return false;
  }
  const health = goalHealth(goal, nowMs);
  if (health.state === "quiet" || health.state === "at_risk") return true;
  if (goal.horizon === "short" && goal.cadence === "daily") return true;
  if (goal.cadence === "weekly" && health.quietDays >= 5) return true;
  if (goal.cadence === "monthly" && health.quietDays >= 18) return true;
  return false;
}

export function goalDiscoveryBrief(goals: readonly Goal[], agentName: string | null): string {
  const active = goals.filter((g) => g.status === "active");
  const existing = active.length
    ? `Active goals already tracked:\n${active.map((g) => `- [${HORIZON_LABEL[g.horizon]}] ${g.title}`).join("\n")}`
    : "No active goals are tracked yet.";
  return [
    `Let's set up and align my goals together${agentName ? `, ${agentName}` : ""}.`,
    "",
    existing,
    "",
    "Please start from what you already know from memory and our recent work, then guide me through a quick, grounded conversation to lock in:",
    "1. Long-term direction (1+ year) and medium-term milestone (this month or quarter).",
    `2. At most ${SHORT_TERM_WIP_LIMIT} active short-term focus goals for right now (this week).`,
    "3. For each priority goal: what 'done' looks like (outcome), a small controllable weekly commitment (lead habit), and the main obstacle + an If-Then fallback plan (WOOP).",
    "",
    "Ask one focused set of questions at a time rather than a wall of forms, push back gently if I try to overcommit, and save confirmed goals with `goal_create` or `goal_update`.",
  ].join("\n");
}

export function goalWorkBrief(goal: Goal, parent: Goal | null): string {
  const lines = [
    `Let's move this ${HORIZON_LABEL[goal.horizon].toLowerCase()} goal forward: "${goal.title}".`,
    parent ? `Supports parent goal: "${parent.title}".` : null,
    goal.why ? `Outcome (why it matters): ${goal.why}` : null,
    goal.progress ? `Latest progress: ${goal.progress}` : null,
    goal.next_step ? `Planned next step: ${goal.next_step}` : null,
    goal.obstacle ? `Watch out for obstacle: ${goal.obstacle}${goal.fallback_plan ? ` (If-Then plan: ${goal.fallback_plan})` : ""}` : null,
    goal.lead_habit ? `Weekly commitment: ${goal.lead_habit.label} (${goal.lead_habit.per_week}x/week).` : null,
    goal.target_date ? `Target date: ${goal.target_date}.` : null,
    "",
    "Review the current state, tell me the highest-leverage next move (or do safe prep work right now), and keep `goal_update` current as we make progress.",
  ];
  return lines.filter((l): l is string => l !== null).join("\n");
}

function formatGoalLine(g: Goal, nowMs: number): string {
  const health = goalHealth(g, nowMs);
  const parts = [
    `[${g.id}] (${HORIZON_LABEL[g.horizon]} · ${health.label}) ${g.title}`,
    g.why ? `  Outcome: ${g.why}` : null,
    g.progress ? `  Progress: ${g.progress}` : null,
    g.next_step ? `  Next step: ${g.next_step}` : null,
    g.obstacle ? `  Obstacle: ${g.obstacle}${g.fallback_plan ? ` -> If-Then: ${g.fallback_plan}` : ""}` : null,
    g.lead_habit ? `  Weekly commitment: ${g.lead_habit.label} (${g.lead_habit.per_week}x/week)` : null,
    g.target_date ? `  Target date: ${g.target_date}` : null,
  ];
  return parts.filter(Boolean).join("\n");
}

export function goalPulseBrief(opts: {
  kind: "daily" | "weekly" | "goal";
  goals: readonly Goal[];
  allGoals: readonly Goal[];
  autonomy: GoalAutonomy;
  now: Date;
}): string {
  const nowMs = opts.now.getTime();
  const prepRule =
    opts.autonomy === "prep_and_nudge"
      ? "Before writing to the person, do safe read-only prep (check recent chats, files, or open Flow threads if relevant; draft a reply_propose or suggestion_create if a concrete outreach or follow-up is waiting) so the person can act in one step rather than starting from zero."
      : "Keep this lightweight: diagnose what is stalling or due without making changes outside goal notes, and propose the single easiest 2-minute first step.";

  if (opts.kind === "weekly") {
    const active = opts.allGoals.filter((g) => g.status === "active");
    return [
      "Goal partner weekly review.",
      "",
      "Active goals:",
      active.map((g) => formatGoalLine(g, nowMs)).join("\n\n") || "(none)",
      "",
      prepRule,
      "",
      "Write a concise, non-judgmental weekly review for Flow:",
      "1. Wins first: what moved this week with concrete evidence.",
      "2. Honest mirror: which goals stayed quiet, and where attention actually went across recent chats.",
      "3. Course-correction: for any stalled goal, offer concrete choices — shrink the next step, activate its If-Then fallback, reschedule, or pause/drop it cleanly without guilt.",
      "4. Confirm next week's top 1-3 short-term priorities, updating goals with `goal_update` once confirmed (or right now for factual evidence).",
    ].join("\n");
  }

  if (opts.kind === "goal" && opts.goals.length === 1) {
    const g = opts.goals[0];
    return [
      `Goal check-in for "${g.title}".`,
      "",
      formatGoalLine(g, nowMs),
      "",
      prepRule,
      "",
      "Send one crisp, supportive message to Flow: state where this goal stands, share any prep you just did, and offer the single clearest next move (or ask if we should shrink, pause, or drop it).",
    ].join("\n");
  }

  return [
    "Goal partner daily focus & nudge.",
    "",
    "Goals to surface today:",
    opts.goals.map((g) => formatGoalLine(g, nowMs)).join("\n\n"),
    "",
    prepRule,
    "",
    "Send a brief, high-signal daily nudge to Flow: highlight today's 1-3 top short-term moves, note anything slipping or due soon with zero guilt, and lower activation energy by putting the first concrete step right in front of the person.",
  ].join("\n");
}
