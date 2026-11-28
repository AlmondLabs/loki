import { GOAL_HORIZONS, HORIZON_LABEL, goalHealth, type Goal, type GoalHorizon } from "../../../core/goals.ts";

export type GoalsView = "active" | "short" | "medium" | "long" | "suggested" | "achieved";

export const GOALS_VIEWS: readonly GoalsView[] = ["active", "short", "medium", "long", "suggested", "achieved"];

export const GOALS_VIEW_LABEL: Record<GoalsView, string> = {
  active: "Active",
  short: "Short-term",
  medium: "Medium-term",
  long: "Long-term",
  suggested: "Suggested",
  achieved: "Achieved",
};

export function goalsViews(goals: readonly Goal[]): Array<{ view: GoalsView; label: string; count: number }> {
  const counts: Record<GoalsView, number> = {
    active: goals.filter((g) => g.status === "active").length,
    short: goals.filter((g) => g.status === "active" && g.horizon === "short").length,
    medium: goals.filter((g) => g.status === "active" && g.horizon === "medium").length,
    long: goals.filter((g) => g.status === "active" && g.horizon === "long").length,
    suggested: goals.filter((g) => g.status === "suggested").length,
    achieved: goals.filter((g) => g.status === "achieved" || g.status === "paused" || g.status === "dropped").length,
  };
  return GOALS_VIEWS.map((view) => ({ view, label: GOALS_VIEW_LABEL[view], count: counts[view] }));
}

export function filterGoalsForView(goals: readonly Goal[], view: GoalsView, query: string): Goal[] {
  const q = query.trim().toLowerCase();
  const matchesQuery = (g: Goal) =>
    !q ||
    g.title.toLowerCase().includes(q) ||
    (g.why ?? "").toLowerCase().includes(q) ||
    (g.next_step ?? "").toLowerCase().includes(q) ||
    (g.progress ?? "").toLowerCase().includes(q);

  const scoped = goals.filter((g) => {
    switch (view) {
      case "active":
        return g.status === "active";
      case "short":
      case "medium":
      case "long":
        return g.status === "active" && g.horizon === view;
      case "suggested":
        return g.status === "suggested";
      case "achieved":
        return g.status === "achieved" || g.status === "paused" || g.status === "dropped";
    }
  });

  const filtered = scoped.filter(matchesQuery);
  const horizonRank: Record<GoalHorizon, number> = { short: 0, medium: 1, long: 2 };
  return [...filtered].sort((a, b) => {
    if (view === "active") {
      const hd = horizonRank[a.horizon] - horizonRank[b.horizon];
      if (hd !== 0) return hd;
    }
    return b.updated_at.localeCompare(a.updated_at);
  });
}

export function goalHealthTone(goal: Goal, nowMs: number): "positive" | "negative" | "brass" | "muted" {
  const h = goalHealth(goal, nowMs);
  if (h.state === "moving" || h.state === "achieved") return "positive";
  if (h.state === "at_risk") return "negative";
  if (h.state === "quiet" || h.state === "suggested") return "brass";
  return "muted";
}

export function goalSectionLabel(goal: Goal, view: GoalsView): string | undefined {
  if (view === "active") return HORIZON_LABEL[goal.horizon];
  if (view === "achieved") {
    if (goal.status === "achieved") return "Achieved";
    if (goal.status === "paused") return "Paused";
    return "Dropped";
  }
  return undefined;
}

export function defaultHorizonForView(view: GoalsView): GoalHorizon {
  return GOAL_HORIZONS.includes(view as GoalHorizon) ? (view as GoalHorizon) : "short";
}

export function resolveDiscoverAgentId(
  agents: ReadonlyArray<{ id: string }>,
  pickedId: string | null,
  partnerAgentId: string | null | undefined,
): string | null {
  if (pickedId && agents.some((a) => a.id === pickedId)) return pickedId;
  if (partnerAgentId && agents.some((a) => a.id === partnerAgentId)) return partnerAgentId;
  return agents.length > 0 ? agents[0].id : null;
}
