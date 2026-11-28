import { defineExtension, section, type Extension } from "@earendil-works/pi-durable";
import {
  GOAL_CHECKIN_CHAT_TITLE,
  GOAL_HORIZONS,
  HORIZON_LABEL,
  SHORT_TERM_WIP_LIMIT,
  goalHealth,
  isGoalCadence,
  isGoalHorizon,
  isGoalStatus,
  weeklyHabitProgress,
  type Goal,
  type GoalProgressSource,
} from "../core/goals.ts";
import { piTool, type ChatTool } from "./chat-tools.ts";
import type { GoalsStore } from "./goals-store.ts";
import { AgentInfoDoc, ChatDoc } from "./kernel/index.ts";
import { isReflectionChat } from "./memory.ts";
import { sections } from "./section-cache.ts";

export const GOALS_TOOLS = ["goal_list", "goal_create", "goal_update"] as const;

function goalSummaryLine(goal: Goal, agentId: string, now: Date): string {
  const health = goalHealth(goal, now.getTime());
  const bits: string[] = [`- [${goal.id}] ${goal.title} (${health.label})`];
  if (goal.agent_id === agentId) bits.push("  owner: you");
  else if (goal.agent_id) bits.push(`  owner: ${goal.agent_id}`);
  if (goal.why) bits.push(`  outcome: ${goal.why}`);
  if (goal.progress) bits.push(`  progress: ${goal.progress}`);
  if (goal.next_step) bits.push(`  next: ${goal.next_step}`);
  if (goal.obstacle) bits.push(`  obstacle: ${goal.obstacle}${goal.fallback_plan ? ` -> if-then: ${goal.fallback_plan}` : ""}`);
  if (goal.lead_habit) {
    const week = weeklyHabitProgress(goal.lead_habit, now);
    bits.push(`  weekly habit: ${goal.lead_habit.label} (${week.done}/${week.target} this week)`);
  }
  if (goal.target_date) bits.push(`  target: ${goal.target_date}`);
  return bits.join("\n");
}

export function goalsSection(store: GoalsStore, agentId: string, now = new Date()): string | undefined {
  const all = store.list();
  const active = all.filter((g) => g.status === "active");
  const suggestedCount = all.filter((g) => g.status === "suggested").length;

  if (!active.length) {
    return [
      "The person has no active goals recorded yet.",
      "Whenever they share an ambition, deadline, or priority for this week, quarter, or year, offer to save it with `goal_create` (confirming outcome, obstacle/fallback, and a small weekly commitment where helpful).",
      suggestedCount
        ? `There ${suggestedCount === 1 ? "is" : "are"} ${suggestedCount} suggested goal candidate${suggestedCount === 1 ? "" : "s"} waiting in Goals.`
        : null,
    ]
      .filter(Boolean)
      .join("\n");
  }

  const lines: string[] = [
    "These are the person's goals — treat them as your own. Connect everyday work to them, proactively propose the next step toward relevant goals, flag when urgent busywork pulls attention away from top short-term priorities, and keep progress current with `goal_update` (or capture newly stated goals with `goal_create`).",
  ];

  const shortActive = active.filter((g) => g.horizon === "short");
  if (shortActive.length > SHORT_TERM_WIP_LIMIT) {
    lines.push(`Note: ${shortActive.length} short-term goals are active (aim for 1–${SHORT_TERM_WIP_LIMIT} in focus at once).`);
  }

  for (const horizon of GOAL_HORIZONS) {
    const group = active.filter((g) => g.horizon === horizon);
    if (!group.length) continue;
    lines.push("", `${HORIZON_LABEL[horizon]}:`);
    for (const goal of group) lines.push(goalSummaryLine(goal, agentId, now));
  }

  if (suggestedCount > 0) {
    lines.push("", `Pending goal suggestions awaiting confirmation: ${suggestedCount} (see goal_list with status="suggested").`);
  }

  return lines.join("\n");
}

export function goalTools(store: GoalsStore): ChatTool[] {
  const caller = async (
    read: Parameters<ChatTool["run"]>[1]["read"],
    conversationId: Parameters<ChatTool["run"]>[1]["conversationId"],
    context: Parameters<ChatTool["run"]>[2],
  ): Promise<{ agentId: string; chatId: string; source: GoalProgressSource }> => {
    const [agent, chat] = await Promise.all([read.snapshot(AgentInfoDoc, context), read.snapshot(ChatDoc, conversationId, context)]);
    const chatId = chat?.id ?? "";
    const source: GoalProgressSource = isReflectionChat(chatId) ? "reflection" : chat?.title === GOAL_CHECKIN_CHAT_TITLE ? "pulse" : "agent";
    return { agentId: agent?.id ?? "", chatId, source };
  };

  return [
    {
      kind: "read",
      name: "goal_list",
      outputSchema: { type: "object" },
      description: "List the person's short, medium, and long term goals with progress, next steps, and health status.",
      parameters: {
        type: "object",
        properties: {
          status: { type: "string", enum: ["suggested", "active", "paused", "achieved", "dropped"] },
          horizon: { type: "string", enum: ["short", "medium", "long"] },
          agent_id: { type: "string", description: "Filter to goals owned by a specific agent." },
        },
        additionalProperties: false,
      },
      run: (args) => {
        const a = args as { status?: unknown; horizon?: unknown; agent_id?: unknown };
        const goals = store.list({
          ...(isGoalStatus(a.status) ? { status: a.status } : {}),
          ...(isGoalHorizon(a.horizon) ? { horizon: a.horizon } : {}),
          ...(typeof a.agent_id === "string" && a.agent_id.trim() ? { agent_id: a.agent_id.trim() } : {}),
        });
        const now = new Date();
        const text = goals.length
          ? goals.map((g) => `[${g.id}] (${g.status} · ${HORIZON_LABEL[g.horizon]} · ${goalHealth(g, now.getTime()).label}) ${g.title}`).join("\n")
          : "no matching goals";
        return Promise.resolve({
          output: [{ type: "text", text }],
          structuredOutput: {
            goals: goals.map((g) => ({
              id: g.id,
              title: g.title,
              horizon: g.horizon,
              status: g.status,
              why: g.why,
              obstacle: g.obstacle,
              fallback_plan: g.fallback_plan,
              parent_id: g.parent_id,
              agent_id: g.agent_id,
              target_date: g.target_date,
              progress: g.progress,
              next_step: g.next_step,
              cadence: g.cadence,
              chat_id: g.chat_id,
              lead_habit: g.lead_habit ? { label: g.lead_habit.label, per_week: g.lead_habit.per_week, checkins: g.lead_habit.checkins } : null,
              last_touched_at: g.last_touched_at,
              last_nudged_at: g.last_nudged_at,
              created_at: g.created_at,
              updated_at: g.updated_at,
            })),
          },
        });
      },
    },
    {
      kind: "read",
      name: "goal_create",
      description:
        "Create a short, medium, or long term goal for the person. Use status='active' when the person explicitly confirms or asks for a goal, or status='suggested' when proposing an inferred candidate for their review.",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string" },
          horizon: { type: "string", enum: ["short", "medium", "long"] },
          status: { type: "string", enum: ["suggested", "active", "paused"] },
          why: { type: "string", description: "What done looks like and why it matters." },
          obstacle: { type: "string", description: "Most likely obstacle (WOOP)." },
          fallback_plan: { type: "string", description: "If-Then fallback plan when the obstacle hits." },
          parent_id: { type: "string", description: "Optional medium or long term parent goal id." },
          agent_id: { type: "string", description: "Optional owning agent id." },
          target_date: { type: "string", description: "Optional YYYY-MM-DD deadline." },
          next_step: { type: "string", description: "Concrete next physical step." },
          cadence: { type: "string", enum: ["daily", "weekly", "monthly", "off"] },
          lead_habit: {
            type: "object",
            properties: {
              label: { type: "string" },
              per_week: { type: "integer", minimum: 1, maximum: 7 },
            },
            required: ["label"],
            additionalProperties: false,
          },
        },
        required: ["title", "horizon"],
        additionalProperties: false,
      },
      run: async (args, call, context) => {
        const { agentId, chatId, source } = await caller(call.read, call.conversationId, context);
        const created = store.create(
          {
            title: typeof args.title === "string" ? args.title : "",
            horizon: isGoalHorizon(args.horizon) ? args.horizon : "short",
            status: args.status === "suggested" || args.status === "active" || args.status === "paused" ? args.status : "active",
            why: typeof args.why === "string" ? args.why : null,
            obstacle: typeof args.obstacle === "string" ? args.obstacle : null,
            fallback_plan: typeof args.fallback_plan === "string" ? args.fallback_plan : null,
            parent_id: typeof args.parent_id === "string" ? args.parent_id : null,
            agent_id: typeof args.agent_id === "string" ? args.agent_id : null,
            target_date: typeof args.target_date === "string" ? args.target_date : null,
            next_step: typeof args.next_step === "string" ? args.next_step : null,
            cadence: isGoalCadence(args.cadence) ? args.cadence : undefined,
            lead_habit:
              args.lead_habit && typeof args.lead_habit === "object"
                ? {
                    label: typeof (args.lead_habit as { label?: unknown }).label === "string" ? (args.lead_habit as { label: string }).label : "",
                    per_week:
                      typeof (args.lead_habit as { per_week?: unknown }).per_week === "number" ? (args.lead_habit as { per_week: number }).per_week : undefined,
                  }
                : null,
          },
          { source, chat_id: chatId || null, agent_id: agentId || null },
        );
        return {
          output: [{ type: "text", text: `created goal ${created.id}: "${created.title}" (${created.status}, ${HORIZON_LABEL[created.horizon]})` }],
        };
      },
    },
    {
      kind: "read",
      name: "goal_update",
      description: "Update a goal's status, next step, WOOP plan, progress note, or weekly lead habit check-in.",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string" },
          title: { type: "string" },
          horizon: { type: "string", enum: ["short", "medium", "long"] },
          status: { type: "string", enum: ["suggested", "active", "paused", "achieved", "dropped"] },
          why: { type: ["string", "null"] },
          obstacle: { type: ["string", "null"] },
          fallback_plan: { type: ["string", "null"] },
          parent_id: { type: ["string", "null"] },
          agent_id: { type: ["string", "null"] },
          target_date: { type: ["string", "null"] },
          progress: { type: ["string", "null"] },
          next_step: { type: ["string", "null"] },
          progress_note: { type: "string", description: "Dated progress or blocker note to append to the goal's evidence log." },
          habit_day: { type: "string", description: "YYYY-MM-DD day to check off on the goal's weekly lead habit." },
          cadence: { type: "string", enum: ["daily", "weekly", "monthly", "off"] },
        },
        required: ["id"],
        additionalProperties: false,
      },
      run: async (args, call, context) => {
        const id = typeof args.id === "string" ? args.id.trim() : "";
        if (!id) throw new Error("goal id required");
        const { agentId, chatId, source } = await caller(call.read, call.conversationId, context);
        const updated = store.update(
          id,
          {
            ...(typeof args.title === "string" ? { title: args.title } : {}),
            ...(isGoalHorizon(args.horizon) ? { horizon: args.horizon } : {}),
            ...(isGoalStatus(args.status) ? { status: args.status } : {}),
            ...(args.why !== undefined ? { why: typeof args.why === "string" ? args.why : null } : {}),
            ...(args.obstacle !== undefined ? { obstacle: typeof args.obstacle === "string" ? args.obstacle : null } : {}),
            ...(args.fallback_plan !== undefined ? { fallback_plan: typeof args.fallback_plan === "string" ? args.fallback_plan : null } : {}),
            ...(args.parent_id !== undefined ? { parent_id: typeof args.parent_id === "string" ? args.parent_id : null } : {}),
            ...(args.agent_id !== undefined ? { agent_id: typeof args.agent_id === "string" ? args.agent_id : null } : {}),
            ...(args.target_date !== undefined ? { target_date: typeof args.target_date === "string" ? args.target_date : null } : {}),
            ...(args.progress !== undefined ? { progress: typeof args.progress === "string" ? args.progress : null } : {}),
            ...(args.next_step !== undefined ? { next_step: typeof args.next_step === "string" ? args.next_step : null } : {}),
            ...(typeof args.progress_note === "string" ? { progress_note: args.progress_note } : {}),
            ...(typeof args.habit_day === "string" ? { habit_day: args.habit_day } : {}),
            ...(isGoalCadence(args.cadence) ? { cadence: args.cadence } : {}),
          },
          { source, chat_id: chatId || null, agent_id: agentId || null },
        );
        return {
          output: [{ type: "text", text: `updated goal ${updated.id}: "${updated.title}" (${updated.status})` }],
        };
      },
    },
  ];
}

export function goalsExtension(store: GoalsStore): Extension {
  return defineExtension({
    name: "loki.goals",
    sections: [
      section("goals", async (input, context) => {
        const agent = await input.read.snapshot(AgentInfoDoc, context);
        const agentId = agent?.id ?? "";
        return sections.get(`goals\u0000${agentId}`, () => goalsSection(store, agentId));
      }),
    ],
    tools: goalTools(store).map(piTool),
  });
}
