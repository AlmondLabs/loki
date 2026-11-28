import { randomBytes } from "node:crypto";
import { statSync } from "node:fs";
import {
  DEFAULT_GOALS_SETTINGS,
  EMPTY_GOALS_PULSE,
  defaultCadenceFor,
  isGoalAutonomy,
  isGoalCadence,
  isGoalHorizon,
  isGoalStatus,
  type Goal,
  type GoalCadence,
  type GoalHorizon,
  type GoalLeadHabit,
  type GoalProgressEntry,
  type GoalProgressSource,
  type GoalStatus,
  type GoalsPulseStatus,
  type GoalsSettings,
  type GoalsSnapshot,
} from "../core/goals.ts";
import { Listeners } from "../core/listeners.ts";
import { readJson, writeJsonAtomic } from "../mod/json-file.ts";
import { sections } from "./section-cache.ts";

const MAX_ENTRIES_PER_GOAL = 50;
const MAX_CHECKINS = 120;

interface StoredGoalsFile {
  version: number;
  goals: Goal[];
  settings: GoalsSettings;
  pulse: GoalsPulseStatus;
}

export interface GoalCreateInput {
  title: string;
  horizon?: GoalHorizon;
  status?: GoalStatus;
  why?: string | null;
  obstacle?: string | null;
  fallback_plan?: string | null;
  parent_id?: string | null;
  agent_id?: string | null;
  target_date?: string | null;
  progress?: string | null;
  next_step?: string | null;
  lead_habit?: { label: string; per_week?: number } | null;
  cadence?: GoalCadence;
  chat_id?: string | null;
}

export interface GoalUpdateInput {
  title?: string;
  horizon?: GoalHorizon;
  status?: GoalStatus;
  why?: string | null;
  obstacle?: string | null;
  fallback_plan?: string | null;
  parent_id?: string | null;
  agent_id?: string | null;
  target_date?: string | null;
  progress?: string | null;
  next_step?: string | null;
  lead_habit?: { label: string; per_week?: number } | null;
  cadence?: GoalCadence;
  chat_id?: string | null;
  progress_note?: string | null;
  habit_day?: string | null;
}

export interface GoalActionMeta {
  source?: GoalProgressSource;
  chat_id?: string | null;
  agent_id?: string | null;
}

function trimOrNull(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length ? trimmed : null;
}

function normalizeDateString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return null;
  return trimmed;
}

function clampHour(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.min(23, Math.floor(value))) : fallback;
}

function clampWeekday(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.min(6, Math.floor(value))) : fallback;
}

function normalizeLeadHabit(raw: unknown): GoalLeadHabit | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const label = trimOrNull(r.label);
  if (!label) return null;
  const perWeekRaw = typeof r.per_week === "number" && Number.isFinite(r.per_week) ? Math.round(r.per_week) : 3;
  const perWeek = Math.max(1, Math.min(7, perWeekRaw));
  const checkins = Array.isArray(r.checkins)
    ? [...new Set(r.checkins.filter((d): d is string => typeof d === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d)))].sort().slice(-MAX_CHECKINS)
    : [];
  return { label, per_week: perWeek, checkins };
}

function normalizeEntry(raw: unknown): GoalProgressEntry | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const note = trimOrNull(r.note);
  const at = typeof r.at === "string" && r.at ? r.at : null;
  if (!note || !at) return null;
  const source: GoalProgressSource = r.source === "user" || r.source === "agent" || r.source === "reflection" || r.source === "pulse" ? r.source : "user";
  return {
    id: typeof r.id === "string" && r.id ? r.id : `ge-${randomBytes(4).toString("hex")}`,
    at,
    note,
    source,
    ...(typeof r.chat_id === "string" && r.chat_id ? { chat_id: r.chat_id } : {}),
    ...(typeof r.agent_id === "string" && r.agent_id ? { agent_id: r.agent_id } : {}),
  };
}

function normalizeGoal(raw: unknown): Goal | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const id = trimOrNull(r.id);
  const title = trimOrNull(r.title);
  if (!id || !title) return null;
  const horizon: GoalHorizon = isGoalHorizon(r.horizon) ? r.horizon : "short";
  const status: GoalStatus = isGoalStatus(r.status) ? r.status : "active";
  const cadence: GoalCadence = isGoalCadence(r.cadence) ? r.cadence : defaultCadenceFor(horizon);
  const nowIso = new Date().toISOString();
  const createdAt = typeof r.created_at === "string" && r.created_at ? r.created_at : nowIso;
  const updatedAt = typeof r.updated_at === "string" && r.updated_at ? r.updated_at : createdAt;
  const entries = Array.isArray(r.entries)
    ? r.entries
        .map(normalizeEntry)
        .filter((e): e is GoalProgressEntry => e !== null)
        .slice(-MAX_ENTRIES_PER_GOAL)
    : [];
  return {
    id,
    title,
    horizon,
    status,
    why: trimOrNull(r.why),
    obstacle: trimOrNull(r.obstacle),
    fallback_plan: trimOrNull(r.fallback_plan),
    parent_id: trimOrNull(r.parent_id),
    agent_id: trimOrNull(r.agent_id),
    target_date: normalizeDateString(r.target_date),
    progress: trimOrNull(r.progress),
    next_step: trimOrNull(r.next_step),
    lead_habit: normalizeLeadHabit(r.lead_habit),
    cadence,
    chat_id: trimOrNull(r.chat_id),
    entries,
    last_touched_at: typeof r.last_touched_at === "string" && r.last_touched_at ? r.last_touched_at : null,
    last_nudged_at: typeof r.last_nudged_at === "string" && r.last_nudged_at ? r.last_nudged_at : null,
    created_at: createdAt,
    updated_at: updatedAt,
  };
}

export function normalizeGoalsSettings(raw: unknown): GoalsSettings {
  if (!raw || typeof raw !== "object") return { ...DEFAULT_GOALS_SETTINGS };
  const r = raw as Record<string, unknown>;
  return {
    enabled: typeof r.enabled === "boolean" ? r.enabled : DEFAULT_GOALS_SETTINGS.enabled,
    partner_agent_id: trimOrNull(r.partner_agent_id),
    autonomy: isGoalAutonomy(r.autonomy) ? r.autonomy : DEFAULT_GOALS_SETTINGS.autonomy,
    daily_hour: clampHour(r.daily_hour, DEFAULT_GOALS_SETTINGS.daily_hour),
    weekly_day: clampWeekday(r.weekly_day, DEFAULT_GOALS_SETTINGS.weekly_day),
    weekly_hour: clampHour(r.weekly_hour, DEFAULT_GOALS_SETTINGS.weekly_hour),
    quiet_start: clampHour(r.quiet_start, DEFAULT_GOALS_SETTINGS.quiet_start),
    quiet_end: clampHour(r.quiet_end, DEFAULT_GOALS_SETTINGS.quiet_end),
    timezone: trimOrNull(r.timezone),
  };
}

function normalizePulseStatus(raw: unknown): GoalsPulseStatus {
  if (!raw || typeof raw !== "object") return { ...EMPTY_GOALS_PULSE };
  const r = raw as Record<string, unknown>;
  return {
    last_run_at: typeof r.last_run_at === "string" && r.last_run_at ? r.last_run_at : null,
    last_note: trimOrNull(r.last_note),
    last_weekly_review_at: typeof r.last_weekly_review_at === "string" && r.last_weekly_review_at ? r.last_weekly_review_at : null,
    last_daily_check_at: typeof r.last_daily_check_at === "string" && r.last_daily_check_at ? r.last_daily_check_at : null,
  };
}

function cloneGoal(g: Goal): Goal {
  return {
    ...g,
    lead_habit: g.lead_habit ? { ...g.lead_habit, checkins: [...g.lead_habit.checkins] } : null,
    entries: g.entries.map((e) => ({ ...e })),
  };
}

export class GoalsStore {
  private readonly file: string;
  private readonly now: () => Date;
  private readonly listeners = new Listeners();
  private cached: { mtimeMs: number; size: number; data: StoredGoalsFile } | null = null;

  constructor(file: string, now: () => Date = () => new Date()) {
    this.file = file;
    this.now = now;
  }

  onChange(listener: () => void): () => void {
    return this.listeners.add(listener);
  }

  private read(): StoredGoalsFile {
    try {
      const st = statSync(this.file);
      if (this.cached && this.cached.mtimeMs === st.mtimeMs && this.cached.size === st.size) {
        return {
          version: 1,
          goals: this.cached.data.goals.map(cloneGoal),
          settings: { ...this.cached.data.settings },
          pulse: { ...this.cached.data.pulse },
        };
      }
      const raw = readJson(this.file) as Partial<StoredGoalsFile> | null;
      const data: StoredGoalsFile = {
        version: 1,
        goals: Array.isArray(raw?.goals) ? raw.goals.map(normalizeGoal).filter((g): g is Goal => g !== null) : [],
        settings: normalizeGoalsSettings(raw?.settings),
        pulse: normalizePulseStatus(raw?.pulse),
      };
      this.cached = { mtimeMs: st.mtimeMs, size: st.size, data };
      return {
        version: 1,
        goals: data.goals.map(cloneGoal),
        settings: { ...data.settings },
        pulse: { ...data.pulse },
      };
    } catch {
      this.cached = null;
      return { version: 1, goals: [], settings: { ...DEFAULT_GOALS_SETTINGS }, pulse: { ...EMPTY_GOALS_PULSE } };
    }
  }

  private write(data: StoredGoalsFile): void {
    writeJsonAtomic(this.file, data, { pretty: true });
    try {
      const st = statSync(this.file);
      this.cached = {
        mtimeMs: st.mtimeMs,
        size: st.size,
        data: { version: 1, goals: data.goals.map(cloneGoal), settings: { ...data.settings }, pulse: { ...data.pulse } },
      };
    } catch {
      this.cached = null;
    }
    sections.clear();
    this.listeners.emit();
  }

  snapshot(): GoalsSnapshot {
    const data = this.read();
    return { goals: data.goals, settings: data.settings, pulse: data.pulse };
  }

  list(filter?: { status?: GoalStatus; horizon?: GoalHorizon; agent_id?: string }): Goal[] {
    const { goals } = this.read();
    return goals.filter((g) => {
      if (filter?.status && g.status !== filter.status) return false;
      if (filter?.horizon && g.horizon !== filter.horizon) return false;
      if (filter?.agent_id && g.agent_id !== filter.agent_id) return false;
      return true;
    });
  }

  get(id: string): Goal | null {
    return this.read().goals.find((g) => g.id === id) ?? null;
  }

  settings(): GoalsSettings {
    return this.read().settings;
  }

  pulseStatus(): GoalsPulseStatus {
    return this.read().pulse;
  }

  private validateParent(goals: readonly Goal[], id: string | null, parentId: string | null): void {
    if (!parentId) return;
    if (id && parentId === id) throw new Error("a goal cannot be its own parent");
    const byId = new Map(goals.map((g) => [g.id, g]));
    if (!byId.has(parentId)) throw new Error(`no parent goal ${parentId}`);
    const seen = new Set<string>(id ? [id] : []);
    let cursor: string | null = parentId;
    while (cursor) {
      if (seen.has(cursor)) throw new Error("parent goal would create a cycle");
      seen.add(cursor);
      cursor = byId.get(cursor)?.parent_id ?? null;
    }
  }

  create(input: GoalCreateInput, meta: GoalActionMeta = {}): Goal {
    const title = trimOrNull(input.title);
    if (!title) throw new Error("a goal needs a title");
    const data = this.read();
    const horizon: GoalHorizon = isGoalHorizon(input.horizon) ? input.horizon : "short";
    const status: GoalStatus = isGoalStatus(input.status) ? input.status : "active";
    const cadence: GoalCadence = isGoalCadence(input.cadence) ? input.cadence : defaultCadenceFor(horizon);
    const parentId = trimOrNull(input.parent_id);
    this.validateParent(data.goals, null, parentId);
    if (input.target_date?.trim() && !normalizeDateString(input.target_date)) {
      throw new Error("target_date must be YYYY-MM-DD");
    }
    const nowIso = this.now().toISOString();
    const progress = trimOrNull(input.progress);
    const goal: Goal = {
      id: `goal-${randomBytes(4).toString("hex")}`,
      title,
      horizon,
      status,
      why: trimOrNull(input.why),
      obstacle: trimOrNull(input.obstacle),
      fallback_plan: trimOrNull(input.fallback_plan),
      parent_id: parentId,
      agent_id: trimOrNull(input.agent_id),
      target_date: normalizeDateString(input.target_date),
      progress,
      next_step: trimOrNull(input.next_step),
      lead_habit: input.lead_habit ? normalizeLeadHabit(input.lead_habit) : null,
      cadence,
      chat_id: trimOrNull(input.chat_id),
      entries: progress
        ? [
            {
              id: `ge-${randomBytes(4).toString("hex")}`,
              at: nowIso,
              note: progress,
              source: meta.source ?? "user",
              ...(meta.chat_id ? { chat_id: meta.chat_id } : {}),
              ...(meta.agent_id ? { agent_id: meta.agent_id } : {}),
            },
          ]
        : [],
      last_touched_at: status === "active" ? nowIso : null,
      last_nudged_at: null,
      created_at: nowIso,
      updated_at: nowIso,
    };
    data.goals.push(goal);
    this.write(data);
    return cloneGoal(goal);
  }

  update(id: string, patch: GoalUpdateInput, meta: GoalActionMeta = {}): Goal {
    const data = this.read();
    const idx = data.goals.findIndex((g) => g.id === id);
    if (idx < 0) throw new Error(`no goal ${id}`);
    const current = data.goals[idx];
    const nowIso = this.now().toISOString();

    const nextTitle = patch.title !== undefined ? trimOrNull(patch.title) : current.title;
    if (!nextTitle) throw new Error("a goal needs a title");

    const nextParent = patch.parent_id !== undefined ? trimOrNull(patch.parent_id) : current.parent_id;
    this.validateParent(data.goals, id, nextParent);

    if (patch.target_date?.trim() && !normalizeDateString(patch.target_date)) {
      throw new Error("target_date must be YYYY-MM-DD");
    }

    const nextHorizon = patch.horizon !== undefined ? (isGoalHorizon(patch.horizon) ? patch.horizon : current.horizon) : current.horizon;
    const nextStatus = patch.status !== undefined ? (isGoalStatus(patch.status) ? patch.status : current.status) : current.status;
    const nextCadence = patch.cadence !== undefined ? (isGoalCadence(patch.cadence) ? patch.cadence : current.cadence) : current.cadence;

    let nextHabit = current.lead_habit;
    if (patch.lead_habit !== undefined) {
      if (patch.lead_habit === null) nextHabit = null;
      else {
        const normalized = normalizeLeadHabit({
          label: patch.lead_habit.label,
          per_week: patch.lead_habit.per_week,
          checkins: current.lead_habit?.checkins ?? [],
        });
        nextHabit = normalized;
      }
    }

    const entries = [...current.entries];
    let touched = false;

    const note = trimOrNull(patch.progress_note);
    if (note) {
      entries.push({
        id: `ge-${randomBytes(4).toString("hex")}`,
        at: nowIso,
        note,
        source: meta.source ?? "user",
        ...(meta.chat_id ? { chat_id: meta.chat_id } : {}),
        ...(meta.agent_id ? { agent_id: meta.agent_id } : {}),
      });
      touched = true;
    }

    const habitDay = normalizeDateString(patch.habit_day);
    if (habitDay && nextHabit) {
      if (!nextHabit.checkins.includes(habitDay)) {
        nextHabit = {
          ...nextHabit,
          checkins: [...nextHabit.checkins, habitDay].sort().slice(-MAX_CHECKINS),
        };
        touched = true;
      }
    }

    const nextProgress = note ?? (patch.progress !== undefined ? trimOrNull(patch.progress) : current.progress);
    const nextStep = patch.next_step !== undefined ? trimOrNull(patch.next_step) : current.next_step;
    if (nextProgress !== current.progress || nextStep !== current.next_step || (patch.status !== undefined && nextStatus !== current.status)) {
      touched = true;
    }

    const updated: Goal = {
      ...current,
      title: nextTitle,
      horizon: nextHorizon,
      status: nextStatus,
      why: patch.why !== undefined ? trimOrNull(patch.why) : current.why,
      obstacle: patch.obstacle !== undefined ? trimOrNull(patch.obstacle) : current.obstacle,
      fallback_plan: patch.fallback_plan !== undefined ? trimOrNull(patch.fallback_plan) : current.fallback_plan,
      parent_id: nextParent,
      agent_id: patch.agent_id !== undefined ? trimOrNull(patch.agent_id) : current.agent_id,
      target_date: patch.target_date !== undefined ? normalizeDateString(patch.target_date) : current.target_date,
      progress: nextProgress,
      next_step: nextStep,
      lead_habit: nextHabit,
      cadence: nextCadence,
      chat_id: patch.chat_id !== undefined ? trimOrNull(patch.chat_id) : current.chat_id,
      entries: entries.slice(-MAX_ENTRIES_PER_GOAL),
      last_touched_at: touched ? nowIso : current.last_touched_at,
      updated_at: nowIso,
    };
    data.goals[idx] = updated;
    this.write(data);
    return cloneGoal(updated);
  }

  logProgress(id: string, note: string, meta: GoalActionMeta = {}): Goal {
    const clean = trimOrNull(note);
    if (!clean) throw new Error("a progress note cannot be empty");
    return this.update(id, { progress_note: clean }, meta);
  }

  toggleHabitCheckin(id: string, day: string, done?: boolean): Goal {
    const cleanDay = normalizeDateString(day);
    if (!cleanDay) throw new Error("day must be YYYY-MM-DD");
    const data = this.read();
    const idx = data.goals.findIndex((g) => g.id === id);
    if (idx < 0) throw new Error(`no goal ${id}`);
    const current = data.goals[idx];
    if (!current.lead_habit) throw new Error("this goal has no weekly habit");
    const has = current.lead_habit.checkins.includes(cleanDay);
    const shouldHave = done ?? !has;
    if (shouldHave === has) return cloneGoal(current);
    const checkins = shouldHave
      ? [...current.lead_habit.checkins, cleanDay].sort().slice(-MAX_CHECKINS)
      : current.lead_habit.checkins.filter((d) => d !== cleanDay);
    const nowIso = this.now().toISOString();
    const updated: Goal = {
      ...current,
      lead_habit: { ...current.lead_habit, checkins },
      last_touched_at: shouldHave ? nowIso : current.last_touched_at,
      updated_at: nowIso,
    };
    data.goals[idx] = updated;
    this.write(data);
    return cloneGoal(updated);
  }

  remove(id: string): boolean {
    const data = this.read();
    const before = data.goals.length;
    if (!data.goals.some((g) => g.id === id)) return false;
    data.goals = data.goals.filter((g) => g.id !== id).map((g) => (g.parent_id === id ? { ...g, parent_id: null } : g));
    if (data.goals.length === before) return false;
    this.write(data);
    return true;
  }

  setSettings(patch: Partial<GoalsSettings>): GoalsSettings {
    const data = this.read();
    data.settings = normalizeGoalsSettings({ ...data.settings, ...patch });
    this.write(data);
    return { ...data.settings };
  }

  recordPulse(patch: Partial<GoalsPulseStatus>): GoalsPulseStatus {
    const data = this.read();
    data.pulse = normalizePulseStatus({ ...data.pulse, ...patch });
    this.write(data);
    return { ...data.pulse };
  }

  markNudged(ids: readonly string[], at = this.now()): void {
    if (!ids.length) return;
    const set = new Set(ids);
    const iso = at.toISOString();
    const data = this.read();
    let changed = false;
    for (let i = 0; i < data.goals.length; i++) {
      if (!set.has(data.goals[i].id)) continue;
      data.goals[i] = { ...data.goals[i], last_nudged_at: iso };
      changed = true;
    }
    if (changed) this.write(data);
  }
}
