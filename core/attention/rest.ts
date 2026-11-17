import type { OutsideSeed } from "../frame-types.ts";
import type { AttentionItem } from "./model.ts";
import { isBlocked } from "./priority.ts";
import { outsideStamp, stampOf } from "./queue.ts";

const MIN = 60_000;
const DAY = 24 * 60 * MIN;

export const REST_FIRST_CHOICES = { "10m": 10 * MIN, "30m": 30 * MIN, "1h": 60 * MIN, "3h": 180 * MIN } as const;
export type RestFirst = keyof typeof REST_FIRST_CHOICES;
export const REST_FIRST_DEFAULT: RestFirst = "1h";
export const REST_FIRST_MS = REST_FIRST_CHOICES[REST_FIRST_DEFAULT];

export function parseRestFirst(raw: string | null): RestFirst {
  return raw !== null && isRestFirst(raw) ? raw : REST_FIRST_DEFAULT;
}

const isRestFirst = (raw: string): raw is RestFirst => Object.hasOwn(REST_FIRST_CHOICES, raw);
export const REST_LATER_CHOICES = { "3h": 180 * MIN, "1d": DAY, "2d": 2 * DAY, "1w": 7 * DAY } as const;
export type RestLater = keyof typeof REST_LATER_CHOICES;
export const REST_LATER_DEFAULT: RestLater = "1d";

const isRestLater = (raw: unknown): raw is RestLater => typeof raw === "string" && Object.hasOwn(REST_LATER_CHOICES, raw);
const isRestFirstValue = (raw: unknown): raw is RestFirst => typeof raw === "string" && isRestFirst(raw);

export type CardKind = "chat" | "email" | "slack" | "jira";

export function cardKindOf(item: Pick<AttentionItem, "outside">): CardKind {
  if (!item.outside) return "chat";
  switch (item.outside.provider) {
    case "gmail":
      return "email";
    case "slack":
      return "slack";
    case "jira":
      return "jira";
  }
}

/**
 * The person's return times for each kind of card, as the daemon keeps them (plan 070, R15, KTD8): ⌘]'s first rest for
 * chats and email (a Slack or Jira card read is finished, so it has none), and ⌘['s return for every kind. Jira's later
 * time came with plan 089, so a set stored or sent before it has none and reads as the default (laterOf); a Mac from
 * before it checks only the keys it knows, so it takes a set with Jira's time and keeps it when it changes another.
 */
export interface ReturnTimes {
  read_first: { chat: RestFirst; email: RestFirst };
  later: { chat: RestLater; email: RestLater; slack: RestLater; jira?: RestLater };
}

export const RETURN_TIMES_DEFAULT: ReturnTimes = {
  read_first: { chat: REST_FIRST_DEFAULT, email: REST_FIRST_DEFAULT },
  later: { chat: REST_LATER_DEFAULT, email: REST_LATER_DEFAULT, slack: REST_LATER_DEFAULT, jira: REST_LATER_DEFAULT },
};

export function isReturnTimes(v: unknown): v is ReturnTimes {
  if (!v || typeof v !== "object") return false;
  const { read_first: first, later } = v as { read_first?: unknown; later?: unknown };
  if (!first || typeof first !== "object" || !later || typeof later !== "object") return false;
  const f = first as Record<string, unknown>;
  const l = later as Record<string, unknown>;
  const known = isRestFirstValue(f.chat) && isRestFirstValue(f.email) && isRestLater(l.chat) && isRestLater(l.email) && isRestLater(l.slack);
  return known && (l.jira === undefined || isRestLater(l.jira));
}

export function readFirstMs(times: ReturnTimes, kind: CardKind): number {
  return REST_FIRST_CHOICES[kind === "slack" || kind === "jira" ? REST_FIRST_DEFAULT : times.read_first[kind]];
}

export function laterOf(times: ReturnTimes, kind: CardKind): RestLater {
  return times.later[kind] ?? REST_LATER_DEFAULT;
}

export function laterMs(times: ReturnTimes, kind: CardKind): number {
  return REST_LATER_CHOICES[laterOf(times, kind)];
}

export const REST_GROWTH = 3;
export const REST_CAP_MS = 7 * 24 * 60 * 60_000;

/** Which key rested a card: ⌘] read it, ⌘[ put it off unread (plan 070). */
export type RestKind = "read" | "later";

/** One chat's rest, as the mod keeps it ("agentId/conversationId" → Rest). */
export interface Rest {
  /**
   * For a read rest, the rung: how many Nexts in a row on this card while nothing new came, 0 for a first-rung rest that
   * did not climb. For a later rest, how many later presses in a row on this card while nothing new came.
   */
  n: number;
  /** ISO time the card comes back. */
  until: string;
  /** stampOf(item) when it was rested: a different stamp means something new, and the rest is over. */
  stamp: string;
  /** ISO time it was set: between Macs the later one wins. */
  at: string;
  /** Which key set it; missing on a rest from before plan 070, which was a read rest. */
  kind?: RestKind;
}

const isRestKind = (v: unknown): boolean => v === undefined || v === "read" || v === "later";

export function isRest(v: unknown): v is Rest {
  const r = v as Partial<Rest> | null;
  return (
    !!r &&
    typeof r === "object" &&
    typeof r.n === "number" &&
    Number.isFinite(r.n) &&
    r.n >= 0 &&
    typeof r.until === "string" &&
    typeof r.stamp === "string" &&
    typeof r.at === "string" &&
    isRestKind(r.kind)
  );
}

export function rungMs(n: number, first: number = REST_FIRST_MS): number {
  return Math.min(REST_CAP_MS, first * REST_GROWTH ** Math.max(0, n - 1));
}

export function rungOf(item: AttentionItem, rest: Rest | undefined): number {
  return rest?.stamp === stampOf(item) ? rest.n : 0;
}

const readRungOf = (item: AttentionItem, rest: Rest | undefined): number => (rest?.kind === "later" ? 0 : rungOf(item, rest));

export function restAfterNext(item: AttentionItem, prev: Rest | undefined, movedOn: boolean, now = Date.now(), first: number = REST_FIRST_MS): Rest | null {
  if (isBlocked(item)) return null;
  const stamp = stampOf(item);
  const rung = readRungOf(item, prev);
  const climbs = !item.unread && !movedOn;
  const n = climbs ? rung + 1 : rung;
  const quiet = !item.outside && item.last_message_at ? Math.max(0, now - Date.parse(item.last_message_at)) : 0;
  const gap = climbs ? Math.min(REST_CAP_MS, Math.max(rungMs(n, first), quiet)) : first;
  return { n, until: new Date(now + gap).toISOString(), stamp, at: new Date(now).toISOString(), kind: "read" };
}

export function restAfterLater(item: AttentionItem, prev: Rest | undefined, now: number, laterMs: number): { rest: Rest; ask: boolean } | null {
  if (isBlocked(item)) return null;
  const n = (prev?.kind === "later" ? rungOf(item, prev) : 0) + 1;
  const rest: Rest = { n, until: new Date(now + laterMs).toISOString(), stamp: stampOf(item), at: new Date(now).toISOString(), kind: "later" };
  return { rest, ask: n >= 2 };
}

export function restUndone(prev: Rest | undefined, now = Date.now()): Rest {
  const at = new Date(now).toISOString();
  return { n: prev?.n ?? 0, until: at, stamp: prev?.stamp ?? "", at, ...(prev?.kind ? { kind: prev.kind } : {}) };
}

export function isResting(item: AttentionItem, rest: Rest | undefined, now = Date.now()): boolean {
  if (!rest || isBlocked(item)) return false;
  return rest.stamp === stampOf(item) && Date.parse(rest.until) > now && !seededSince(item.outside?.seeds, rest);
}

const seededSince = (seeds: readonly OutsideSeed[] | undefined, rest: Rest): boolean => (seeds ?? []).some((s) => s.at > rest.at);

export function outsideResting(rest: Rest | undefined, newestMessageId: string, now: number, seeds: readonly OutsideSeed[] = []): boolean {
  return !!rest && rest.stamp === outsideStamp(newestMessageId) && Date.parse(rest.until) > now && !seededSince(seeds, rest);
}

export function restState(item: AttentionItem, rest: Rest | undefined, now = Date.now()): { resting: boolean; rung: number; rested: boolean } {
  const resting = isResting(item, rest, now);
  return { resting, rung: rungOf(item, rest), rested: !resting && !!rest && rest.stamp === stampOf(item) };
}

export function movesOn(prev: { id: string; action: string } | null, id: string): boolean {
  return prev?.id === id && prev.action !== "next";
}
