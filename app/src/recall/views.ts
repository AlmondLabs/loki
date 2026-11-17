import type { RecallSnapshot } from "../../../core/recall/model.ts";

export type LearnView = "review" | "leads" | "all" | "deleted";
export const LEARN_VIEWS: LearnView[] = ["review", "leads", "all", "deleted"];

export const LEARN_VIEW_LABEL: Record<LearnView, string> = { review: "Review", leads: "Leads", all: "All Cards", deleted: "Deleted" };

export function learnViews(snap: RecallSnapshot | null, due: number): Array<{ view: LearnView; label: string; count: number }> {
  const count: Record<LearnView, number> = {
    review: snap ? due : 0,
    leads: snap?.leads.length ?? 0,
    all: snap?.cards.length ?? 0,
    deleted: (snap?.rejected.length ?? 0) + (snap?.dismissed_leads.length ?? 0),
  };
  return LEARN_VIEWS.map((view) => ({ view, label: LEARN_VIEW_LABEL[view], count: count[view] }));
}

export function stepLearnView(v: LearnView, d: 1 | -1): LearnView {
  return LEARN_VIEWS[(LEARN_VIEWS.indexOf(v) + d + LEARN_VIEWS.length) % LEARN_VIEWS.length];
}

export function parseLearnView(raw: string | null): LearnView {
  return LEARN_VIEWS.includes(raw as LearnView) ? (raw as LearnView) : "review";
}
