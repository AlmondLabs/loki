import { messageOf } from "../../core/errors.ts";
import { goalDiscoveryBrief, goalWorkBrief, type Goal, type GoalsSnapshot } from "../../core/goals.ts";
import type { GoalPulseRunResult } from "../../daemon/goal-pulse.ts";
import type { GoalsStore } from "../../daemon/goals-store.ts";
import { fail, reply, type FrameContext, type FrameHandlers } from "./context.ts";

export interface GoalsDeps {
  goals?: {
    store: Pick<GoalsStore, "snapshot" | "get" | "create" | "update" | "remove" | "logProgress" | "toggleHabitCheckin" | "setSettings">;
    runPulse?: (opts?: { kind?: "daily" | "weekly" | "goal"; goalId?: string }) => Promise<GoalPulseRunResult>;
    startChat?: (opts: { agentId?: string | null; title: string }) => Promise<{ agent_id: string; conversation_id: string; agent_name: string | null }>;
    chatLive?: (agentId: string | null, chatId: string | null) => boolean;
  };
}

export function goalsFrames({ goals }: GoalsDeps): FrameHandlers {
  if (!goals) {
    const off = () => fail("goals are not available in this mod");
    return {
      goals_list: off,
      goals_create: off,
      goals_update: off,
      goals_delete: off,
      goals_progress_add: off,
      goals_habit_toggle: off,
      goals_settings_set: off,
      goals_pulse_run: off,
      goals_work_start: off,
      goals_discover_start: off,
    };
  }

  const { store } = goals;
  const snapshot = (): GoalsSnapshot => store.snapshot();
  const changed = (ctx: FrameContext) => ctx.broadcast({ type: "goals_changed" });
  const runAction = (work: () => void, ctx: FrameContext) => {
    try {
      work();
      changed(ctx);
      return reply(snapshot());
    } catch (err) {
      return fail(messageOf(err));
    }
  };

  return {
    goals_list: () => reply(snapshot()),
    goals_create: (p, ctx) => runAction(() => store.create(p, { source: "user" }), ctx),
    goals_update: (p, ctx) => runAction(() => store.update(p.id, p, { source: "user" }), ctx),
    goals_delete: ({ id }, ctx) =>
      runAction(() => {
        if (!store.remove(id)) throw new Error("no such goal");
      }, ctx),
    goals_progress_add: ({ id, note }, ctx) => runAction(() => store.logProgress(id, note, { source: "user" }), ctx),
    goals_habit_toggle: ({ id, day, done }, ctx) => runAction(() => store.toggleHabitCheckin(id, day, done), ctx),
    goals_settings_set: (p, ctx) => runAction(() => store.setSettings(p), ctx),
    goals_pulse_run: async (p, ctx) => {
      if (!goals.runPulse) return fail("Goal Pulse is not available in this mod");
      const out = await goals.runPulse({
        ...(p.kind ? { kind: p.kind } : {}),
        ...(p.goal_id ? { goalId: p.goal_id } : {}),
      });
      changed(ctx);
      return reply(out);
    },
    goals_work_start: async ({ id }, ctx) => {
      const snap = snapshot();
      const goal = snap.goals.find((g) => g.id === id);
      if (!goal) return fail("no such goal");
      const targetAgent = goal.agent_id ?? snap.settings.partner_agent_id;
      if (goal.chat_id && goals.chatLive?.(targetAgent, goal.chat_id)) {
        const chatAgent = targetAgent ?? "";
        if (chatAgent) {
          return reply({ agent_id: chatAgent, conversation_id: goal.chat_id, created: false, brief: null });
        }
      }
      if (!goals.startChat) return fail("cannot start a goal chat in this mod");
      const made = await goals.startChat({ agentId: targetAgent, title: goal.title });
      const parent: Goal | null = goal.parent_id ? (snap.goals.find((g) => g.id === goal.parent_id) ?? null) : null;
      store.update(goal.id, { chat_id: made.conversation_id }, { source: "user" });
      changed(ctx);
      return reply({
        agent_id: made.agent_id,
        conversation_id: made.conversation_id,
        created: true,
        brief: goalWorkBrief(goal, parent),
      });
    },
    goals_discover_start: async (p, ctx) => {
      if (!goals.startChat) return fail("cannot start a discovery chat in this mod");
      const snap = snapshot();
      const targetAgent = p.agent_id ?? snap.settings.partner_agent_id;
      const made = await goals.startChat({ agentId: targetAgent, title: "Goal Discovery" });
      changed(ctx);
      return reply({
        agent_id: made.agent_id,
        conversation_id: made.conversation_id,
        created: true,
        brief: goalDiscoveryBrief(snap.goals, made.agent_name),
      });
    },
  };
}
