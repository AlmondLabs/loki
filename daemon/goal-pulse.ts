import type { TranscriptRow } from "../core/attention/transcript.ts";
import {
  GOAL_CHECKIN_CHAT_TITLE,
  goalNeedsNudge,
  goalPulseBrief,
  isInQuietHours,
  isoDateInZone,
  isoWeekKey,
  localTimeParts,
  type Goal,
  type GoalsSettings,
} from "../core/goals.ts";
import type { LocalConversationInfo, LocalConversationRow } from "../mod/chats.ts";
import type { Delivery } from "./engine.ts";
import type { GoalsStore } from "./goals-store.ts";

export const GOAL_PULSE_TICK_MS = 5 * 60_000;

export interface GoalPulseChats {
  list(): LocalConversationRow[];
  info(conversationId: string, agentId?: string | null): LocalConversationInfo | null;
  since(conversationId: string, agentId: string | null, from: number, to?: number, steps?: boolean): { rows: TranscriptRow[]; lines: number };
  ensureLoaded?(conversationId: string, agentId?: string | null): Promise<void> | void;
}

export interface GoalPulseDeps {
  store: GoalsStore;
  agents(): Array<{ id: string; name: string }>;
  chats: GoalPulseChats;
  createChat(agentId: string, cwd: string | null, title: string | null): Promise<{ agentId: string; conversationId: string }>;
  deliver(agentId: string, conversationId: string, text: string): Promise<Delivery | null>;
  busy(agentId: string, conversationId: string): Promise<boolean>;
  report?(message: string, level?: "info" | "warning" | "error"): void;
  now?: () => Date;
  tickMs?: number;
  defaultCwd: string;
  folderForAgent?(agentId: string): string | null;
}

export interface GoalPulseRunResult {
  note: string;
  agent_id: string | null;
  conversation_id: string | null;
}

export class GoalPulse {
  private readonly deps: GoalPulseDeps;
  private timer: ReturnType<typeof setInterval> | null = null;
  private ticking = false;

  constructor(deps: GoalPulseDeps) {
    this.deps = deps;
  }

  start(): void {
    this.stop();
    this.timer = setInterval(
      () => void this.tick().catch((e: unknown) => this.deps.report?.(`goal pulse failed: ${String(e)}`)),
      this.deps.tickMs ?? GOAL_PULSE_TICK_MS,
    );
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  private resolvePartnerAgentId(settings: GoalsSettings): string | null {
    const agents = this.deps.agents();
    if (!agents.length) return null;
    if (settings.partner_agent_id && agents.some((a) => a.id === settings.partner_agent_id)) {
      return settings.partner_agent_id;
    }
    return agents[0].id;
  }

  private ownerAgentFor(goal: Goal, partnerAgentId: string): string {
    const agents = this.deps.agents();
    if (goal.agent_id && agents.some((a) => a.id === goal.agent_id)) return goal.agent_id;
    return partnerAgentId;
  }

  private liveCheckinChat(agentId: string): string | null {
    const rows = this.deps.chats
      .list()
      .filter((r) => r.agentId === agentId && !r.archived && !r.hidden)
      .sort((a, b) => (b.lastMessageAt ?? "").localeCompare(a.lastMessageAt ?? ""));
    for (const r of rows) {
      const info = this.deps.chats.info(r.conversationId, r.agentId);
      if (info?.title === GOAL_CHECKIN_CHAT_TITLE) return r.conversationId;
    }
    return null;
  }

  private liveGoalChat(agentId: string, chatId: string | null): string | null {
    if (!chatId) return null;
    const row = this.deps.chats.list().find((r) => r.agentId === agentId && r.conversationId === chatId && !r.archived && !r.hidden);
    return row ? row.conversationId : null;
  }

  private async ensureChat(agentId: string, preferredChatId: string | null): Promise<string> {
    const existingGoalChat = this.liveGoalChat(agentId, preferredChatId);
    if (existingGoalChat) return existingGoalChat;
    const existingCheckin = this.liveCheckinChat(agentId);
    if (existingCheckin) return existingCheckin;
    const cwd = this.deps.folderForAgent?.(agentId) ?? this.deps.defaultCwd;
    const created = await this.deps.createChat(agentId, cwd, GOAL_CHECKIN_CHAT_TITLE);
    return created.conversationId;
  }

  private async hasUnansweredNudge(agentId: string, chatId: string, lastNudgedAt: string | null): Promise<boolean> {
    if (!lastNudgedAt) return false;
    await this.deps.chats.ensureLoaded?.(chatId, agentId);
    const { rows } = this.deps.chats.since(chatId, agentId, 0);
    for (let i = rows.length - 1; i >= 0; i--) {
      const row = rows[i];
      if (row.role === "user") return false;
      if (row.role === "assistant") {
        const msgAt = row.at ? Date.parse(row.at) : Number.NaN;
        const nudgedAt = Date.parse(lastNudgedAt);
        if (!Number.isFinite(msgAt) || !Number.isFinite(nudgedAt)) return true;
        return msgAt >= nudgedAt;
      }
    }
    return false;
  }

  private weeklyDue(now: Date, settings: GoalsSettings, lastWeeklyAt: string | null): boolean {
    const local = localTimeParts(now, settings.timezone);
    if (local.weekday !== settings.weekly_day || local.hour < settings.weekly_hour) return false;
    const currentWeek = isoWeekKey(now, settings.timezone);
    if (!lastWeeklyAt) return true;
    const lastWeek = isoWeekKey(new Date(lastWeeklyAt), settings.timezone);
    return lastWeek !== currentWeek;
  }

  private dailyDue(now: Date, settings: GoalsSettings, lastDailyAt: string | null): boolean {
    const local = localTimeParts(now, settings.timezone);
    if (local.hour < settings.daily_hour) return false;
    if (!lastDailyAt) return true;
    const lastDay = isoDateInZone(new Date(lastDailyAt), settings.timezone);
    return lastDay !== local.date;
  }

  async tick(now = this.now()): Promise<boolean> {
    if (this.ticking) return false;
    this.ticking = true;
    try {
      const snap = this.deps.store.snapshot();
      const { settings, pulse, goals } = snap;
      if (!settings.enabled) return false;
      const active = goals.filter((g) => g.status === "active");
      if (!active.length) return false;
      if (isInQuietHours(now, settings)) return false;

      const partnerAgentId = this.resolvePartnerAgentId(settings);
      if (!partnerAgentId) return false;

      if (this.weeklyDue(now, settings, pulse.last_weekly_review_at)) {
        const chatId = await this.ensureChat(partnerAgentId, null);
        if (await this.deps.busy(partnerAgentId, chatId)) return false;
        if (await this.hasUnansweredNudge(partnerAgentId, chatId, pulse.last_weekly_review_at)) return false;
        const brief = goalPulseBrief({ kind: "weekly", goals: active, allGoals: goals, autonomy: settings.autonomy, now });
        const delivery = await this.deps.deliver(partnerAgentId, chatId, brief);
        if (!delivery) return false;
        const iso = now.toISOString();
        this.deps.store.recordPulse({
          last_run_at: iso,
          last_weekly_review_at: iso,
          last_note: "Weekly review sent to Flow",
        });
        return true;
      }

      if (!this.dailyDue(now, settings, pulse.last_daily_check_at)) return false;

      const dueGoals = active.filter((g) => goalNeedsNudge(g, settings, now));
      if (!dueGoals.length) return false;

      const byTarget = new Map<string, { agentId: string; preferredChatId: string | null; goals: Goal[] }>();
      for (const g of dueGoals) {
        const agentId = this.ownerAgentFor(g, partnerAgentId);
        const preferredChatId = this.liveGoalChat(agentId, g.chat_id);
        const key = `${agentId}\u0000${preferredChatId ?? ""}`;
        const existing = byTarget.get(key);
        if (existing) existing.goals.push(g);
        else byTarget.set(key, { agentId, preferredChatId, goals: [g] });
      }

      for (const group of byTarget.values()) {
        const chatId = await this.ensureChat(group.agentId, group.preferredChatId);
        if (await this.deps.busy(group.agentId, chatId)) continue;
        const eligible: Goal[] = [];
        for (const g of group.goals) {
          if (!(await this.hasUnansweredNudge(group.agentId, chatId, g.last_nudged_at))) {
            eligible.push(g);
          }
        }
        if (!eligible.length) continue;
        const brief = goalPulseBrief({ kind: "daily", goals: eligible, allGoals: goals, autonomy: settings.autonomy, now });
        const delivery = await this.deps.deliver(group.agentId, chatId, brief);
        if (!delivery) continue;
        const iso = now.toISOString();
        this.deps.store.markNudged(
          eligible.map((g) => g.id),
          now,
        );
        this.deps.store.recordPulse({
          last_run_at: iso,
          last_daily_check_at: iso,
          last_note: `Daily focus sent for ${eligible.length} goal${eligible.length === 1 ? "" : "s"}`,
        });
        return true;
      }
      return false;
    } finally {
      this.ticking = false;
    }
  }

  async runNow(opts: { kind?: "daily" | "weekly" | "goal"; goalId?: string } = {}): Promise<GoalPulseRunResult> {
    const now = this.now();
    const snap = this.deps.store.snapshot();
    const { settings, goals } = snap;
    const partnerAgentId = this.resolvePartnerAgentId(settings);
    if (!partnerAgentId) {
      return { note: "create an agent first so loki can run a goal check-in", agent_id: null, conversation_id: null };
    }
    const active = goals.filter((g) => g.status === "active");
    if (!active.length) {
      return { note: "no active goals yet", agent_id: null, conversation_id: null };
    }

    const kind = opts.goalId ? "goal" : (opts.kind ?? "daily");
    if (kind === "goal" && opts.goalId) {
      const target = goals.find((g) => g.id === opts.goalId);
      if (!target) return { note: "that goal no longer exists", agent_id: null, conversation_id: null };
      const agentId = this.ownerAgentFor(target, partnerAgentId);
      const chatId = await this.ensureChat(agentId, target.chat_id);
      if (await this.deps.busy(agentId, chatId)) {
        return { note: "that chat is busy right now", agent_id: agentId, conversation_id: chatId };
      }
      const brief = goalPulseBrief({ kind: "goal", goals: [target], allGoals: goals, autonomy: settings.autonomy, now });
      await this.deps.deliver(agentId, chatId, brief);
      const iso = now.toISOString();
      this.deps.store.markNudged([target.id], now);
      this.deps.store.recordPulse({ last_run_at: iso, last_note: `Checked in on "${target.title}"` });
      return { note: `checked in on "${target.title}" in Flow`, agent_id: agentId, conversation_id: chatId };
    }

    if (kind === "weekly") {
      const chatId = await this.ensureChat(partnerAgentId, null);
      if (await this.deps.busy(partnerAgentId, chatId)) {
        return { note: "the check-in chat is busy right now", agent_id: partnerAgentId, conversation_id: chatId };
      }
      const brief = goalPulseBrief({ kind: "weekly", goals: active, allGoals: goals, autonomy: settings.autonomy, now });
      await this.deps.deliver(partnerAgentId, chatId, brief);
      const iso = now.toISOString();
      this.deps.store.recordPulse({ last_run_at: iso, last_weekly_review_at: iso, last_note: "Weekly review sent to Flow" });
      return { note: "weekly goal review started in Flow", agent_id: partnerAgentId, conversation_id: chatId };
    }

    const chatId = await this.ensureChat(partnerAgentId, null);
    if (await this.deps.busy(partnerAgentId, chatId)) {
      return { note: "the check-in chat is busy right now", agent_id: partnerAgentId, conversation_id: chatId };
    }
    const brief = goalPulseBrief({ kind: "daily", goals: active, allGoals: goals, autonomy: settings.autonomy, now });
    await this.deps.deliver(partnerAgentId, chatId, brief);
    const iso = now.toISOString();
    this.deps.store.markNudged(
      active.map((g) => g.id),
      now,
    );
    this.deps.store.recordPulse({ last_run_at: iso, last_daily_check_at: iso, last_note: "Daily focus check-in sent to Flow" });
    return { note: "daily goal focus sent to Flow", agent_id: partnerAgentId, conversation_id: chatId };
  }
}
