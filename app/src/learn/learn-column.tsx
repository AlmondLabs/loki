import type { LearnSnapshot } from "../../../core/learn/model.ts";
import type { IconName } from "../shared/icons";
import type { PlaceSources } from "../shell/sidebar";
import { LEARN_VIEWS, learnViews, type LearnView } from "./views";

const VIEW_ICON: Record<LearnView, IconName> = { review: "learn", leads: "link", all: "file", deleted: "trash" };

export function learnSources({
  snap,
  due,
  view,
  onView,
}: {
  snap: LearnSnapshot | null;
  due: number;
  view: LearnView;
  onView: (view: LearnView) => void;
}): PlaceSources {
  return {
    items: learnViews(snap, due).map((v) => ({ id: v.view, title: v.label, icon: VIEW_ICON[v.view], count: v.view === "review" ? due : 0 })),
    selected: view,
    onSelect: (id) => {
      const chosen = LEARN_VIEWS.find((v) => v === id);
      if (chosen) onView(chosen);
    },
  };
}
