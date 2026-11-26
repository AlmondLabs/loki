import { isDue, isNew, type Schedule } from "./fsrs.ts";

export interface CardSource {
  agent_id: string | null;
  agent_name: string | null;
  conversation_id: string | null;
  /** The conversation's title (a desk name, "main chat") when known. */
  title: string | null;
  /** ISO time of the message the fact was drawn from. */
  at: string | null;
}

export const isLearnId = (v: unknown): v is string => typeof v === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(v);

export interface Card {
  id: string;
  front: string;
  back: string;
  tags: string[];
  source: CardSource;
  created_at: string;
  updated_at: string;
  /** Who last changed the text: the worker ("learn", legacy "recall") or the person ("you"). */
  updated_by: "learn" | "recall" | "you";
  /** Earlier wordings, oldest first, so an update the worker made can be read against what it replaced. */
  previous: Array<{ front: string; back: string; at: string; by: "learn" | "recall" | "you" }>;
}

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

export interface Lead {
  id: string;
  title: string;
  /** One line quoting the moment it came up. */
  why: string;
  /** A primer fits one sitting; a course takes several. */
  depth: "primer" | "course";
  source: CardSource;
  created_at: string;
}
export interface DismissedLead {
  lead: Lead;
  at: string;
}
export interface Lesson {
  lead: Lead;
  agent_id: string;
  conversation_id: string;
  started_at: string;
  /** Set by the mod's snapshot: the conversation holds no message yet, so the brief never arrived (the app sends it again). */
  empty?: boolean;
}

export const LEARN_PREFIX = "[Learn]";
export const writerChatId = (agentId: string): string => `learn-${agentId}`;
export const isWriterChat = (chatId: string): boolean => chatId.startsWith("learn-") || chatId.startsWith("recall-");

export const learnTitle = (title: string): string => `${LEARN_PREFIX} · ${title.trim()}`;
export const isLearnTitle = (title: string | null | undefined): boolean => typeof title === "string" && title.trimStart().startsWith(LEARN_PREFIX);

export interface LearnSnapshot {
  cards: CardWithSchedule[];
  rejected: Rejected[];
  worker: WorkerStatus;
  leads: Lead[];
  dismissed_leads: DismissedLead[];
  lessons: Lesson[];
}

export type LearnReply = Omit<LearnSnapshot, "leads" | "dismissed_leads" | "lessons"> & Partial<Pick<LearnSnapshot, "leads" | "dismissed_leads" | "lessons">>;

export interface WorkerStatus {
  enabled: boolean;
  daily_cap: number;
  last_run_at: string | null;
  last_run_note: string | null;
  /** Cards written today, against the cap. */
  written_today: number;
}

export function reviewQueue(cards: CardWithSchedule[], now = Date.now()): CardWithSchedule[] {
  const due = cards.filter((c) => isDue(c.schedule, now));
  const fresh = due.filter((c) => isNew(c.schedule)).sort((a, b) => a.card.created_at.localeCompare(b.card.created_at));
  const rest = due.filter((c) => !isNew(c.schedule)).sort((a, b) => a.schedule.due.localeCompare(b.schedule.due));
  return [...fresh, ...rest];
}

export const dueCount = (cards: CardWithSchedule[], now = Date.now()) => cards.filter((c) => isDue(c.schedule, now)).length;

export function updatedSinceReview(c: CardWithSchedule): boolean {
  return (
    (c.card.updated_by === "learn" || c.card.updated_by === "recall") &&
    c.card.previous.length > 0 &&
    (!c.schedule.last_review || c.card.updated_at > c.schedule.last_review)
  );
}

export function toAnkiTsv(cards: CardWithSchedule[]): string {
  const cell = (s: string) => s.replace(/\t/g, " ").replace(/\r?\n/g, "<br>");
  return cards.map((c) => `${cell(c.card.front)}\t${cell(c.card.back)}\t${c.card.tags.join(" ")}`).join("\n") + (cards.length ? "\n" : "");
}
