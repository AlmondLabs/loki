import { isDue, isNew, type Schedule } from "./fsrs.ts";

/**
 * A card is one fact worth keeping: a question on the front, a short answer on the back, and where
 * it came from. Cards are written by the recall worker in the mod, never in chat; the person only
 * meets them in the Recall section, where deleting one is the signal that shapes what gets written
 * next. Content (agent-editable) and schedule (the person's review history) are kept apart.
 */
export interface CardSource {
  agentId: string | null;
  agentName: string | null;
  conversationId: string | null;
  /** The conversation's title (a desk name, "main chat") when known. */
  title: string | null;
  /** ISO time of the message the fact was drawn from. */
  at: string | null;
}

export interface Card {
  id: string;
  front: string;
  back: string;
  tags: string[];
  source: CardSource;
  createdAt: string;
  updatedAt: string;
  /** Who last changed the text: the worker ("recall") or the person ("you"). */
  updatedBy: "recall" | "you";
  /** Earlier wordings, oldest first, so an update the worker made can be read against what it replaced. */
  previous: Array<{ front: string; back: string; at: string; by: "recall" | "you" }>;
}

/** A deleted card, kept as a negative example for the worker so it never comes back reworded. */
export interface Rejected {
  card: Card;
  at: string;
  /** Reviews before it was deleted — a card thrown out unseen says "not wanted"; one failed five times says "badly written". */
  reps: number;
}

export interface CardWithSchedule {
  card: Card;
  schedule: Schedule;
}

/**
 * Something the person could learn properly: a concept that went by in a conversation without being
 * understood. The writer proposes leads in the same call that writes cards; the person starts a lesson
 * from one, or dismisses it, and the dismissed pile is quoted back so a lead never returns reworded.
 */
export interface Lead {
  id: string;
  /** A few words: "Savings Plan utilisation". */
  title: string;
  /** One line quoting the moment it came up. */
  why: string;
  /** A primer fits one sitting; a course takes several. */
  depth: "primer" | "course";
  source: CardSource;
  createdAt: string;
}
export interface DismissedLead {
  lead: Lead;
  at: string;
}
/** A lead the person started: the `[Learn] · <title>` conversation it became. */
export interface Lesson {
  lead: Lead;
  agentId: string;
  conversationId: string;
  startedAt: string;
  /** Set by the mod's snapshot: the conversation holds no message yet, so the brief never arrived (the app sends it again). */
  empty?: boolean;
}

/** Learn conversations carry this prefix in their title; the inbox leaves them out, the tree keeps them. */
export const LEARN_PREFIX = "[Learn]";
export const learnTitle = (title: string): string => `${LEARN_PREFIX} · ${title.trim()}`;
export const isLearnTitle = (title: string | null | undefined): boolean => typeof title === "string" && title.trimStart().startsWith(LEARN_PREFIX);

/** What the section shows and the phone mirrors. */
export interface RecallSnapshot {
  cards: CardWithSchedule[];
  rejected: Rejected[];
  /** The worker: when it last ran, what it did, and what it is set to. */
  worker: WorkerStatus;
  leads: Lead[];
  dismissedLeads: DismissedLead[];
  lessons: Lesson[];
}

export interface WorkerStatus {
  enabled: boolean;
  /** The model handle the worker asks, or null for the harness's default. */
  model: string | null;
  dailyCap: number;
  lastRunAt: string | null;
  lastRunNote: string | null;
  /** Cards written today, against the cap. */
  writtenToday: number;
}

/**
 * The review order: new cards first (the first sight of a card is also the moment to delete it), then
 * the due ones most overdue first. Cards that are not due are not in the queue.
 */
export function reviewQueue(cards: CardWithSchedule[], now = Date.now()): CardWithSchedule[] {
  const due = cards.filter((c) => isDue(c.schedule, now));
  const fresh = due.filter((c) => isNew(c.schedule)).sort((a, b) => a.card.createdAt.localeCompare(b.card.createdAt));
  const rest = due.filter((c) => !isNew(c.schedule)).sort((a, b) => a.schedule.due.localeCompare(b.schedule.due));
  return [...fresh, ...rest];
}

export const dueCount = (cards: CardWithSchedule[], now = Date.now()) => cards.filter((c) => isDue(c.schedule, now)).length;

/** True when the worker changed the text after the person last saw the card. */
export function updatedSinceReview(c: CardWithSchedule): boolean {
  return c.card.updatedBy === "recall" && c.card.previous.length > 0 && (!c.schedule.lastReview || c.card.updatedAt > c.schedule.lastReview);
}

/** Anki's plain-text import: one card per line, front TAB back TAB tags. */
export function toAnkiTsv(cards: CardWithSchedule[]): string {
  const cell = (s: string) => s.replace(/\t/g, " ").replace(/\r?\n/g, "<br>");
  return cards.map((c) => `${cell(c.card.front)}\t${cell(c.card.back)}\t${c.card.tags.join(" ")}`).join("\n") + (cards.length ? "\n" : "");
}
