import { attentionGoalsCount, type Goal } from "../../../core/goals.ts";
import type { IconName } from "../shared/icons";
import type { PlaceSources } from "../shell/sidebar";
import { GOALS_VIEWS, GOALS_VIEW_LABEL, goalsViews, type GoalsView } from "./views";

const VIEW_ICON: Record<GoalsView, IconName> = {
  active: "target",
  short: "clock",
  medium: "checklist",
  long: "globe",
  suggested: "suggest",
  achieved: "check",
};

export function goalSources({
  goals,
  view,
  onView,
  onNewGoal,
}: {
  goals: readonly Goal[];
  view: GoalsView;
  onView: (view: GoalsView) => void;
  onNewGoal: () => void;
}): PlaceSources {
  const attention = attentionGoalsCount(goals);
  const views = goalsViews(goals);
  return {
    items: views.map((v) => ({
      id: v.view,
      title: GOALS_VIEW_LABEL[v.view],
      icon: VIEW_ICON[v.view],
      count: v.view === "suggested" ? v.count : v.view === "active" ? attention : 0,
    })),
    selected: view,
    onSelect: (id) => {
      const chosen = GOALS_VIEWS.find((v) => v === id);
      if (chosen) onView(chosen);
    },
    action: { label: "New Goal", icon: "plus", onRun: onNewGoal },
  };
}
