import type { RecallSnapshot } from "../../../core/recall/model.ts";

/** Learn's four views, its sources in the sidebar (plan 2026-11-14-1330, R14; they were tabs, then a list column). */
export type LearnView = "review" | "leads" | "all" | "deleted";
/** Learn's views, in the order the sidebar lists them and ⌘[ ⌘] step through them. */
export const LEARN_VIEWS: LearnView[] = ["review", "leads", "all", "deleted"];

/** Each view's name, in title case as a source's name is: the sidebar's row and the list's toolbar title. */
export const LEARN_VIEW_LABEL: Record<LearnView, string> = { review: "Review", leads: "Leads", all: "All Cards", deleted: "Deleted" };

/** Each view with the count of what it shows: cards due, leads, every card, the deleted cards and leads. */
export function learnViews(snap: RecallSnapshot | null, due: number): Array<{ view: LearnView; label: string; count: number }> {
  const count: Record<LearnView, number> = {
    review: snap ? due : 0,
    leads: snap?.leads.length ?? 0,
    all: snap?.cards.length ?? 0,
    deleted: (snap?.rejected.length ?? 0) + (snap?.dismissed_leads.length ?? 0),
  };
  return LEARN_VIEWS.map((view) => ({ view, label: LEARN_VIEW_LABEL[view], count: count[view] }));
}

/** ⌘[ / ⌘]: the view before or after, round the four. */
export function stepLearnView(v: LearnView, d: 1 | -1): LearnView {
  return LEARN_VIEWS[(LEARN_VIEWS.indexOf(v) + d + LEARN_VIEWS.length) % LEARN_VIEWS.length];
}

/** A stored view read back; anything unknown is the review deck. */
export function parseLearnView(raw: string | null): LearnView {
  return LEARN_VIEWS.includes(raw as LearnView) ? (raw as LearnView) : "review";
}
