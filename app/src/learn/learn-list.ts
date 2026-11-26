import { describeGap, isDue, isNew } from "../../../core/learn/fsrs.ts";
import type { CardWithSchedule, DismissedLead, Lead, Lesson, Rejected, WorkerStatus } from "../../../core/learn/model.ts";
import { ago } from "../shared/ago";
import type { ContentRow } from "../shell/content-list";
import { resolve } from "../shell/keymap";

export function dueWord(c: CardWithSchedule, now = Date.now()): string {
  if (isNew(c.schedule)) return "New";
  if (isDue(c.schedule, now)) return "Due";
  return `In ${describeGap(new Date(c.schedule.due).getTime() - now)}`;
}

export function reviewRows(queue: readonly CardWithSchedule[], now: number): ContentRow[] {
  return queue.map((c) => ({
    id: c.card.id,
    title: c.card.front,
    preview: c.card.source.title ?? c.card.source.agent_name ?? undefined,
    time: dueWord(c, now),
  }));
}

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

export const leadRowId = (id: string) => `lead:${id}`;
export const lessonRowId = (conversationId: string) => `lesson:${conversationId}`;

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

export const rejectedRowId = (id: string) => `card:${id}`;
export const dismissedRowId = (id: string) => `lead:${id}`;

export function deletedRows(rejected: readonly Rejected[], dismissed: readonly DismissedLead[], now: number): ContentRow[] {
  return [
    ...rejected.map((r) => ({ id: rejectedRowId(r.card.id), section: "Deleted Cards", title: r.card.front, preview: r.card.back, time: ago(r.at, now) })),
    ...dismissed.map((d) => ({ id: dismissedRowId(d.lead.id), section: "Dismissed Leads", title: d.lead.title, preview: d.lead.why, time: ago(d.at, now) })),
  ];
}

export function writtenLine(worker: WorkerStatus): string {
  if (worker.daily_cap > 0 && worker.written_today >= worker.daily_cap) return `today's ${worker.daily_cap} cards are written — more after midnight`;
  return `${worker.written_today} of ${worker.daily_cap} written today`;
}

export function workerLine(worker: WorkerStatus, now: number): string {
  if (!worker.enabled) return "Learn is off";
  if (!worker.last_run_at) return `Has not run yet · ${writtenLine(worker)}`;
  const when = ago(worker.last_run_at, now);
  return `Last run ${when === "now" ? "just now" : `${when} ago`} · ${writtenLine(worker)}`;
}

const DECK_ANSWERS = new Set(["learn.reveal", "learn.again", "learn.good"]);

export function holdDeckKeys(e: KeyboardEvent): void {
  const b = resolve(e, "learn");
  if (b && DECK_ANSWERS.has(b.id)) e.stopPropagation();
}
