import { describeGap, isDue, isNew } from "../../../core/recall/fsrs.ts";
import type { CardWithSchedule, DismissedLead, Lead, Lesson, Rejected, WorkerStatus } from "../../../core/recall/model.ts";
import { ago } from "../shared/ago";
import type { ContentRow } from "../shell/content-list";
import { resolve } from "../shell/keymap";

/** Learn's lists (plan 2026-11-14-1330, R14): each view's rows for the list column, and the keys the Review list keeps. */

/** Where a card stands: "Due", "In 3d", "New". */
export function dueWord(c: CardWithSchedule, now = Date.now()): string {
  if (isNew(c.schedule)) return "New";
  if (isDue(c.schedule, now)) return "Due";
  return `In ${describeGap(new Date(c.schedule.due).getTime() - now)}`;
}

/**
 * Review's rows: the due queue as the deck will take it, each card's front and where it came from. The answer stays
 * off the row, so the list never gives a card away.
 */
export function reviewRows(queue: readonly CardWithSchedule[], now: number): ContentRow[] {
  return queue.map((c) => ({
    id: c.card.id,
    title: c.card.front,
    preview: c.card.source.title ?? c.card.source.agent_name ?? undefined,
    time: dueWord(c, now),
  }));
}

/** All Cards' rows: every card, the newest edit first, those the Search finds in a front, a back or a tag. */
export function cardRows(cards: readonly CardWithSchedule[], query: string, now: number): ContentRow[] {
  const needle = query.trim().toLowerCase();
  const found = (c: CardWithSchedule) =>
    !needle ||
    c.card.front.toLowerCase().includes(needle) ||
    c.card.back.toLowerCase().includes(needle) ||
    c.card.tags.some((t) => t.toLowerCase().includes(needle));
  return cards
    .filter(found)
    .sort((a, b) => b.card.updated_at.localeCompare(a.card.updated_at))
    .map((c) => ({ id: c.card.id, title: c.card.front, preview: c.card.back, time: dueWord(c, now) }));
}

/** A Leads row's id for an open lead. */
export const leadRowId = (id: string) => `lead:${id}`;
/** A Leads row's id for a lesson under way, by its chat. */
export const lessonRowId = (conversationId: string) => `lesson:${conversationId}`;

/** Leads' rows: the open leads, newest first as the writer keeps them, then the lessons under way in a section of their own. */
export function leadRows(leads: readonly Lead[], lessons: readonly Lesson[], now: number): ContentRow[] {
  return [
    ...leads.map((l) => ({ id: leadRowId(l.id), title: l.title, preview: l.why, time: ago(l.created_at, now) })),
    ...lessons.map((s) => ({
      id: lessonRowId(s.conversation_id),
      section: "Lessons Under Way",
      title: s.lead.title,
      preview: s.empty ? "The brief never arrived" : (s.lead.source.agent_name ?? undefined),
      time: ago(s.started_at, now),
    })),
  ];
}

/** A Deleted row's id for a deleted card. */
export const rejectedRowId = (id: string) => `card:${id}`;
/** A Deleted row's id for a dismissed lead. */
export const dismissedRowId = (id: string) => `lead:${id}`;

/** Deleted's rows, in two sections: the deleted cards the writer learns from, and the leads dismissed with Not This. */
export function deletedRows(rejected: readonly Rejected[], dismissed: readonly DismissedLead[], now: number): ContentRow[] {
  return [
    ...rejected.map((r) => ({ id: rejectedRowId(r.card.id), section: "Deleted Cards", title: r.card.front, preview: r.card.back, time: ago(r.at, now) })),
    ...dismissed.map((d) => ({ id: dismissedRowId(d.lead.id), section: "Dismissed Leads", title: d.lead.title, preview: d.lead.why, time: ago(d.at, now) })),
  ];
}

/** "3 of 5 written today", or, at the cap, that cards resume after midnight. */
export function writtenLine(worker: WorkerStatus): string {
  if (worker.daily_cap > 0 && worker.written_today >= worker.daily_cap) return `today's ${worker.daily_cap} cards are written — more after midnight`;
  return `${worker.written_today} of ${worker.daily_cap} written today`;
}

/** All Cards' grey line under the list's title: whether the writer is on, when it last ran, and today's count. */
export function workerLine(worker: WorkerStatus, now: number): string {
  if (!worker.enabled) return "Learn is off";
  if (!worker.last_run_at) return `Has not run yet · ${writtenLine(worker)}`;
  const when = ago(worker.last_run_at, now);
  return `Last run ${when === "now" ? "just now" : `${when} ago`} · ${writtenLine(worker)}`;
}

/** The deck's answers: what Review's keys do to the card in the detail. */
const DECK_ANSWERS = new Set(["recall.reveal", "recall.again", "recall.good"]);

/**
 * A key in Review's list (KTD3): the deck's answers belong to the detail, so while the list has focus they stop here,
 * before the window's keymap, and → never grades a card the person is only browsing to. The list stops its own ↑ ↓
 * Return and Tab; this stops the rest (← → space 1 2). Every other key goes on: X, E and O act on the card, and ⌘[ ⌘]
 * step the views.
 */
export function holdDeckKeys(e: KeyboardEvent): void {
  const b = resolve(e, "learn");
  if (b && DECK_ANSWERS.has(b.id)) e.stopPropagation();
}
