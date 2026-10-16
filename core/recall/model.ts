import { isDue, isNew, type Schedule } from "./fsrs.ts";

/**
 * A card is one fact worth keeping: a question on the front, a short answer on the back, and where
 * it came from. Cards are written by Learn's background pass (daemon/learn.ts), never in chat; the person only
 * meets them in the Learn section, where deleting one is the signal that shapes what gets written
 * next. Content (agent-editable) and schedule (the person's review history) are kept apart.
 */
export interface CardSource {
  agent_id: string | null;
  agent_name: string | null;
  conversation_id: string | null;
  /** The conversation's title (a desk name, "main chat") when known. */
  title: string | null;
  /** ISO time of the message the fact was drawn from. */
  at: string | null;
}

/** A card or lead id names a file (`cards/<id>.json`): letters, digits, `-` and `_` only, so no id can name a file outside. */
export const isRecallId = (v: unknown): v is string => typeof v === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(v);

/** One card's content and where it came from; its review history is kept apart, in its schedule. */
export interface Card {
  id: string;
  front: string;
  back: string;
  tags: string[];
  source: CardSource;
  created_at: string;
  updated_at: string;
  /** Who last changed the text: the worker ("recall") or the person ("you"). */
  updated_by: "recall" | "you";
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

/** A card beside its schedule, as the Learn section and the review deck use them. */
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
  created_at: string;
}
/** A lead the person dismissed, kept with when, so it is quoted back to the writer and never proposed again. */
export interface DismissedLead {
  lead: Lead;
  at: string;
}
/** A lead the person started: the `[Learn] · <title>` conversation it became. */
export interface Lesson {
  lead: Lead;
  agent_id: string;
  conversation_id: string;
  started_at: string;
  /** Set by the mod's snapshot: the conversation holds no message yet, so the brief never arrived (the app sends it again). */
  empty?: boolean;
}

/** Learn conversations carry this prefix in their title; the inbox leaves them out, the tree keeps them. */
export const LEARN_PREFIX = "[Learn]";
/** Learn's hidden writer chat of an agent on loki's daemon: one per agent, its asks compacted away after each. */
export const writerChatId = (agentId: string): string => `recall-${agentId}`;
/** Whether a chat id is one of Learn's hidden writer chats. */
export const isWriterChat = (chatId: string): boolean => chatId.startsWith("recall-");

/** The title of the conversation a lesson starts: `[Learn] · <title>`. */
export const learnTitle = (title: string): string => `${LEARN_PREFIX} · ${title.trim()}`;
/** Whether a conversation's title marks it as a lesson. */
export const isLearnTitle = (title: string | null | undefined): boolean => typeof title === "string" && title.trimStart().startsWith(LEARN_PREFIX);

/** What the section shows and the phone mirrors. */
export interface RecallSnapshot {
  cards: CardWithSchedule[];
  rejected: Rejected[];
  /** The worker: when it last ran, what it did, and what it is set to. */
  worker: WorkerStatus;
  leads: Lead[];
  dismissed_leads: DismissedLead[];
  lessons: Lesson[];
}

/** A `recall` reply as a mod of any age sends it: older mods had no leads or lessons, and send none. */
export type RecallReply = Omit<RecallSnapshot, "leads" | "dismissed_leads" | "lessons"> &
  Partial<Pick<RecallSnapshot, "leads" | "dismissed_leads" | "lessons">>;

/** Learn's settings and last run (daemon/passes-state.ts), as the Learn section shows them. */
export interface WorkerStatus {
  enabled: boolean;
  daily_cap: number;
  last_run_at: string | null;
  last_run_note: string | null;
  /** Cards written today, against the cap. */
  written_today: number;
}

/**
 * The review order: new cards first (the first sight of a card is also the moment to delete it), then
 * the due ones most overdue first. Cards that are not due are not in the queue.
 */
export function reviewQueue(cards: CardWithSchedule[], now = Date.now()): CardWithSchedule[] {
  const due = cards.filter((c) => isDue(c.schedule, now));
  const fresh = due.filter((c) => isNew(c.schedule)).sort((a, b) => a.card.created_at.localeCompare(b.card.created_at));
  const rest = due.filter((c) => !isNew(c.schedule)).sort((a, b) => a.schedule.due.localeCompare(b.schedule.due));
  return [...fresh, ...rest];
}

/** How many cards are due for review at `now`, new ones included. */
export const dueCount = (cards: CardWithSchedule[], now = Date.now()) => cards.filter((c) => isDue(c.schedule, now)).length;

/** True when the worker changed the text after the person last saw the card. */
export function updatedSinceReview(c: CardWithSchedule): boolean {
  return c.card.updated_by === "recall" && c.card.previous.length > 0 && (!c.schedule.last_review || c.card.updated_at > c.schedule.last_review);
}

/** Anki's plain-text import: one card per line, front TAB back TAB tags. */
export function toAnkiTsv(cards: CardWithSchedule[]): string {
  const cell = (s: string) => s.replace(/\t/g, " ").replace(/\r?\n/g, "<br>");
  return cards.map((c) => `${cell(c.card.front)}\t${cell(c.card.back)}\t${c.card.tags.join(" ")}`).join("\n") + (cards.length ? "\n" : "");
}
