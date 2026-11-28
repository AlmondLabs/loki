import { Type } from "typebox";
import {
  isGoalAutonomy,
  isGoalCadence,
  isGoalHorizon,
  isGoalStatus,
  type GoalCadence,
  type GoalHorizon,
  type GoalStatus,
  type GoalsSettings,
} from "../goals.ts";
import { compiledCheck, isAgentId, nothing, str, strOr, type Raw } from "./primitives.ts";
import { PHONE, push, request } from "./types.ts";

const GoalIdSchema = Type.String({ pattern: "^[A-Za-z0-9_-]{3,64}$" });
const DateSchema = Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}$" });
const checkGoalId = compiledCheck(GoalIdSchema);
const checkDate = compiledCheck(DateSchema);

function optStrOrNull(v: unknown): string | null | undefined {
  if (v === undefined) return undefined;
  if (v === null) return null;
  return str(v) ? v : undefined;
}

function parseLeadHabit(v: unknown): { label: string; per_week?: number } | null | undefined | string {
  if (v === undefined) return undefined;
  if (v === null) return null;
  if (typeof v !== "object") return "lead_habit must be an object or null";
  const r = v as Raw;
  if (!str(r.label) || !r.label.trim()) return "lead_habit.label required";
  const perWeek = r.per_week;
  if (perWeek !== undefined && (typeof perWeek !== "number" || !Number.isFinite(perWeek) || perWeek < 1 || perWeek > 7)) {
    return "lead_habit.per_week must be 1 to 7";
  }
  return { label: r.label.trim(), ...(typeof perWeek === "number" ? { per_week: Math.round(perWeek) } : {}) };
}

function parseIntRange(v: unknown, min: number, max: number, name: string): number | undefined | string {
  if (v === undefined) return undefined;
  if (typeof v !== "number" || !Number.isFinite(v)) return `${name} must be a number`;
  const n = Math.floor(v);
  if (n < min || n > max) return `${name} must be ${min} to ${max}`;
  return n;
}

export const goalsFrames = {
  goals_list: request("goals", "every goal, its settings, and Goal Pulse status", nothing, PHONE),

  goals_create: request(
    "goals",
    "create a goal",
    (m: Raw) => {
      if (!str(m.title) || !m.title.trim()) return "title required";
      const horizon: GoalHorizon = isGoalHorizon(m.horizon) ? m.horizon : "short";
      if (m.horizon !== undefined && !isGoalHorizon(m.horizon)) return "horizon must be short, medium, or long";
      const status: GoalStatus | undefined = m.status === undefined ? undefined : isGoalStatus(m.status) ? m.status : undefined;
      if (m.status !== undefined && !isGoalStatus(m.status)) return "invalid goal status";
      const cadence: GoalCadence | undefined = m.cadence === undefined ? undefined : isGoalCadence(m.cadence) ? m.cadence : undefined;
      if (m.cadence !== undefined && !isGoalCadence(m.cadence)) return "invalid goal cadence";
      if (m.parent_id !== undefined && m.parent_id !== null && !checkGoalId(m.parent_id)) return "invalid parent_id";
      if (m.agent_id !== undefined && m.agent_id !== null && !isAgentId(m.agent_id)) return "invalid agent_id";
      if (m.target_date !== undefined && m.target_date !== null && m.target_date !== "" && !checkDate(m.target_date)) return "target_date must be YYYY-MM-DD";
      const habit = parseLeadHabit(m.lead_habit);
      if (typeof habit === "string") return habit;
      return {
        title: m.title.trim(),
        horizon,
        ...(status ? { status } : {}),
        ...(cadence ? { cadence } : {}),
        ...(m.why !== undefined ? { why: optStrOrNull(m.why) } : {}),
        ...(m.obstacle !== undefined ? { obstacle: optStrOrNull(m.obstacle) } : {}),
        ...(m.fallback_plan !== undefined ? { fallback_plan: optStrOrNull(m.fallback_plan) } : {}),
        ...(m.parent_id !== undefined ? { parent_id: m.parent_id } : {}),
        ...(m.agent_id !== undefined ? { agent_id: m.agent_id } : {}),
        ...(m.target_date !== undefined ? { target_date: m.target_date === "" ? null : m.target_date } : {}),
        ...(m.next_step !== undefined ? { next_step: optStrOrNull(m.next_step) } : {}),
        ...(habit !== undefined ? { lead_habit: habit } : {}),
      };
    },
    PHONE,
  ),

  goals_update: request(
    "goals",
    "update an existing goal",
    (m: Raw) => {
      if (!checkGoalId(m.id)) return "goal id required";
      if (m.title !== undefined && (!str(m.title) || !m.title.trim())) return "title cannot be empty";
      if (m.horizon !== undefined && !isGoalHorizon(m.horizon)) return "horizon must be short, medium, or long";
      if (m.status !== undefined && !isGoalStatus(m.status)) return "invalid goal status";
      if (m.cadence !== undefined && !isGoalCadence(m.cadence)) return "invalid goal cadence";
      if (m.parent_id !== undefined && m.parent_id !== null && !checkGoalId(m.parent_id)) return "invalid parent_id";
      if (m.agent_id !== undefined && m.agent_id !== null && !isAgentId(m.agent_id)) return "invalid agent_id";
      if (m.target_date !== undefined && m.target_date !== null && m.target_date !== "" && !checkDate(m.target_date)) return "target_date must be YYYY-MM-DD";
      const habit = parseLeadHabit(m.lead_habit);
      if (typeof habit === "string") return habit;
      return {
        id: m.id,
        ...(str(m.title) ? { title: m.title.trim() } : {}),
        ...(isGoalHorizon(m.horizon) ? { horizon: m.horizon } : {}),
        ...(isGoalStatus(m.status) ? { status: m.status } : {}),
        ...(isGoalCadence(m.cadence) ? { cadence: m.cadence } : {}),
        ...(m.why !== undefined ? { why: optStrOrNull(m.why) } : {}),
        ...(m.obstacle !== undefined ? { obstacle: optStrOrNull(m.obstacle) } : {}),
        ...(m.fallback_plan !== undefined ? { fallback_plan: optStrOrNull(m.fallback_plan) } : {}),
        ...(m.parent_id !== undefined ? { parent_id: m.parent_id } : {}),
        ...(m.agent_id !== undefined ? { agent_id: m.agent_id } : {}),
        ...(m.target_date !== undefined ? { target_date: m.target_date === "" ? null : m.target_date } : {}),
        ...(m.progress !== undefined ? { progress: optStrOrNull(m.progress) } : {}),
        ...(m.next_step !== undefined ? { next_step: optStrOrNull(m.next_step) } : {}),
        ...(habit !== undefined ? { lead_habit: habit } : {}),
      };
    },
    PHONE,
  ),

  goals_delete: request("goals", "delete a goal", (m: Raw) => (checkGoalId(m.id) ? { id: m.id } : "goal id required"), PHONE),

  goals_progress_add: request(
    "goals",
    "log a dated progress note on a goal",
    (m: Raw) => {
      if (!checkGoalId(m.id)) return "goal id required";
      if (!str(m.note) || !m.note.trim()) return "note required";
      return { id: m.id, note: m.note.trim() };
    },
    PHONE,
  ),

  goals_habit_toggle: request(
    "goals",
    "toggle a day on a goal's weekly lead habit",
    (m: Raw) => {
      if (!checkGoalId(m.id)) return "goal id required";
      if (!checkDate(m.day)) return "day must be YYYY-MM-DD";
      return { id: m.id, day: m.day, ...(typeof m.done === "boolean" ? { done: m.done } : {}) };
    },
    PHONE,
  ),

  goals_settings_set: request("goals", "update Goal Pulse and partner settings", (m: Raw) => {
    const out: Partial<GoalsSettings> = {};
    if (m.enabled !== undefined) {
      if (typeof m.enabled !== "boolean") return "enabled must be true or false";
      out.enabled = m.enabled;
    }
    if (m.partner_agent_id !== undefined) {
      if (m.partner_agent_id !== null && !isAgentId(m.partner_agent_id)) return "invalid partner_agent_id";
      out.partner_agent_id = m.partner_agent_id;
    }
    if (m.autonomy !== undefined) {
      if (!isGoalAutonomy(m.autonomy)) return "autonomy must be prep_and_nudge or nudge_only";
      out.autonomy = m.autonomy;
    }
    const dailyHour = parseIntRange(m.daily_hour, 0, 23, "daily_hour");
    if (typeof dailyHour === "string") return dailyHour;
    if (dailyHour !== undefined) out.daily_hour = dailyHour;

    const weeklyDay = parseIntRange(m.weekly_day, 0, 6, "weekly_day");
    if (typeof weeklyDay === "string") return weeklyDay;
    if (weeklyDay !== undefined) out.weekly_day = weeklyDay;

    const weeklyHour = parseIntRange(m.weekly_hour, 0, 23, "weekly_hour");
    if (typeof weeklyHour === "string") return weeklyHour;
    if (weeklyHour !== undefined) out.weekly_hour = weeklyHour;

    const quietStart = parseIntRange(m.quiet_start, 0, 23, "quiet_start");
    if (typeof quietStart === "string") return quietStart;
    if (quietStart !== undefined) out.quiet_start = quietStart;

    const quietEnd = parseIntRange(m.quiet_end, 0, 23, "quiet_end");
    if (typeof quietEnd === "string") return quietEnd;
    if (quietEnd !== undefined) out.quiet_end = quietEnd;

    if (m.timezone !== undefined) {
      out.timezone = m.timezone === null ? null : strOr(m.timezone, null);
    }
    return out;
  }),

  goals_pulse_run: request("goals_pulse", "run a daily, weekly, or per-goal check-in now", (m: Raw) => {
    if (m.kind !== undefined && m.kind !== "daily" && m.kind !== "weekly" && m.kind !== "goal") return "kind must be daily, weekly, or goal";
    if (m.goal_id !== undefined && m.goal_id !== null && !checkGoalId(m.goal_id)) return "invalid goal_id";
    const kind: "daily" | "weekly" | "goal" | undefined = m.kind === "daily" || m.kind === "weekly" || m.kind === "goal" ? m.kind : undefined;
    const out: { kind?: "daily" | "weekly" | "goal"; goal_id?: string } = {
      ...(kind ? { kind } : {}),
      ...(typeof m.goal_id === "string" ? { goal_id: m.goal_id } : {}),
    };
    return out;
  }),

  goals_work_start: request(
    "goals_chat",
    "open or create a chat to work on a goal",
    (m: Raw) => (checkGoalId(m.id) ? { id: m.id } : "goal id required"),
    PHONE,
  ),

  goals_discover_start: request(
    "goals_chat",
    "start a conversational goal discovery chat with an agent",
    (m: Raw) => {
      if (m.agent_id !== undefined && m.agent_id !== null && !isAgentId(m.agent_id)) return "invalid agent_id";
      return { ...(typeof m.agent_id === "string" ? { agent_id: m.agent_id } : {}) };
    },
    PHONE,
  ),

  goals_changed: push("Goals changed: clients refetch"),
} as const;
