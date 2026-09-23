import type { RecallSnapshot } from "../../../core/recall/model.ts";

/** Learn's four views, which the list column lists (plan 013 U11; they were tabs). */
export type LearnView = "review" | "leads" | "all" | "deleted";
export const LEARN_VIEWS: LearnView[] = ["review", "leads", "all", "deleted"];

const LABEL: Record<LearnView, string> = { review: "Review", leads: "Leads", all: "All cards", deleted: "Deleted" };

/** Each view with the count of what it shows: cards due, leads, every card, the deleted cards and leads. */
export function learnViews(snap: RecallSnapshot | null, due: number): { view: LearnView; label: string; count: number }[] {
  const count: Record<LearnView, number> = {
    review: snap ? due : 0,
    leads: snap?.leads.length ?? 0,
    all: snap?.cards.length ?? 0,
    deleted: (snap?.rejected.length ?? 0) + (snap?.dismissedLeads.length ?? 0),
  };
  return LEARN_VIEWS.map((view) => ({ view, label: LABEL[view], count: count[view] }));
}

/** ⌘[ / ⌘]: the view before or after, round the four. */
export function stepLearnView(v: LearnView, d: 1 | -1): LearnView {
  return LEARN_VIEWS[(LEARN_VIEWS.indexOf(v) + d + LEARN_VIEWS.length) % LEARN_VIEWS.length];
}

/** A stored view read back; anything unknown is the review deck. */
export function parseLearnView(raw: string | null): LearnView {
  return LEARN_VIEWS.includes(raw as LearnView) ? (raw as LearnView) : "review";
}
