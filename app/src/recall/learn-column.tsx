import type { RecallSnapshot } from "../../../core/recall/model.ts";
import type { IconName } from "../shared/icons";
import type { PlaceSources } from "../shell/sidebar";
import { LEARN_VIEWS, learnViews, type LearnView } from "./views";

const VIEW_ICON: Record<LearnView, IconName> = { review: "learn", leads: "link", all: "file", deleted: "archive" };

/** Learn's own row in the sidebar: it stands for no one view, so choosing it keeps the view showing. */
const LEARN_PLACE = "";

/**
 * Learn's views as its sources in the sidebar (plan 2026-11-14-1330, R14), in the order ⌘[ ⌘] step them. Only Review
 * has a grey count, the cards due, as Mail counts only the unread; the list's toolbar counts the rest. Choosing one
 * shows that view's items in the list.
 */
export function learnSources({
  snap,
  due,
  view,
  onView,
}: {
  snap: RecallSnapshot | null;
  due: number;
  view: LearnView;
  onView: (view: LearnView) => void;
}): PlaceSources {
  return {
    items: learnViews(snap, due).map((v) => ({ id: v.view, title: v.label, icon: VIEW_ICON[v.view], count: v.view === "review" ? due : 0 })),
    selected: view,
    all: LEARN_PLACE,
    onSelect: (id) => {
      const chosen = LEARN_VIEWS.find((v) => v === id);
      if (chosen) onView(chosen);
    },
  };
}
