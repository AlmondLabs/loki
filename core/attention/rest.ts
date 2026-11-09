/**
 * Rest: Next on a stale Inbox card hides it for a while, longer each time (plan 026). A stale card has nothing new,
 * no approval and no question; the n-th Next on it in a row rests it for
 *
 *   rest = min(REST_CAP_MS, max(first · REST_GROWTH^(n − 1), how long the chat has been quiet))
 *
 * where `first` is the person's setting, an hour unless they changed it (plan 065): long enough that a chat set aside
 * stays set aside while they finish the one in front of them, instead of coming back half-loaded. A chat quiet for two
 * days stays away two days more. Next on a card with something new reads it and rests it for the first rung only,
 * without climbing; so does a Next straight after replying on the same card, which is moving on, and the answer
 * landing ends that rest at once. A stopped agent (an approval, a question) never rests.
 *
 * Each rest is kept with the card's content stamp (queue.ts stampOf). Anything new in the chat changes the stamp,
 * which ends the rest and starts the ladder again: the agent's next message, question or approval, and so whatever the
 * person sends, which starts a turn. Opening or reading the chat changes nothing, so a card read and set aside keeps
 * resting. The mod keeps every chat's rest (mod/seen.ts), so the Mac, the phone and paired Macs see the same Inbox.
 *
 * Plan 070 gives a rest a kind. ⌘] is a "read" rest, the ladder above; on an outside card (an email) it starts at the
 * first rung whatever the thread's age, because an old newsletter read once is not a chat left quiet for a week (KTD10).
 * ⌘[ is a "later" rest: the card stays unread and comes back after the kind's return time, a day unless the person
 * picked another. A later rest's `n` counts the later presses on the same stamp, so the second one can ask when (R7);
 * a read rest or anything new starts that count over (R8). How long each key rests each kind of card is the person's
 * setting, kept on the daemon beside the rests (ReturnTimes, KTD8); a press stores its absolute end, so changing a
 * setting moves later presses only.
 */
import type { AttentionItem } from "./model.ts";
import { isBlocked } from "./priority.ts";
import { outsideStamp, stampOf } from "./queue.ts";

const MIN = 60_000;
const DAY = 24 * 60 * MIN;

/** The first rungs a person can pick in Preferences › Inbox, by the key their choice is stored under. */
export const REST_FIRST_CHOICES = { "10m": 10 * MIN, "30m": 30 * MIN, "1h": 60 * MIN, "3h": 180 * MIN } as const;
/** A key of REST_FIRST_CHOICES. */
export type RestFirst = keyof typeof REST_FIRST_CHOICES;
/** The first rung unless the person picked another: an hour, long enough to finish the chat in front of them. */
export const REST_FIRST_DEFAULT: RestFirst = "1h";
/** How long the first rest lasts by default. */
export const REST_FIRST_MS = REST_FIRST_CHOICES[REST_FIRST_DEFAULT];

/** A stored choice as a key of REST_FIRST_CHOICES; anything else (nothing stored, an old value) reads as the default. */
export function parseRestFirst(raw: string | null): RestFirst {
  return raw !== null && isRestFirst(raw) ? raw : REST_FIRST_DEFAULT;
}

const isRestFirst = (raw: string): raw is RestFirst => Object.hasOwn(REST_FIRST_CHOICES, raw);
/** How long ⌘[ puts a card off, by the key the person's choice is stored under (Preferences › Inbox, plan 070). */
export const REST_LATER_CHOICES = { "3h": 180 * MIN, "1d": DAY, "2d": 2 * DAY, "1w": 7 * DAY } as const;
/** A key of REST_LATER_CHOICES. */
export type RestLater = keyof typeof REST_LATER_CHOICES;
/** ⌘['s return unless the person picked another: a day. */
export const REST_LATER_DEFAULT: RestLater = "1d";

const isRestLater = (raw: unknown): raw is RestLater => typeof raw === "string" && Object.hasOwn(REST_LATER_CHOICES, raw);
const isRestFirstValue = (raw: unknown): raw is RestFirst => typeof raw === "string" && isRestFirst(raw);

/** The kinds of Inbox card that keep their own return times (R15). */
export type CardKind = "chat" | "email" | "slack";

/** A card's kind for its return times: a chat, or an outside card by its provider. */
export function cardKindOf(item: Pick<AttentionItem, "outside">): CardKind {
  if (!item.outside) return "chat";
  return item.outside.provider === "slack" ? "slack" : "email";
}

/**
 * The person's return times for each kind of card, as the daemon keeps them (plan 070, R15, KTD8): ⌘]'s first rest for
 * chats and email (a Slack card read is finished, so it has none), and ⌘['s return for every kind.
 */
export interface ReturnTimes {
  read_first: { chat: RestFirst; email: RestFirst };
  later: { chat: RestLater; email: RestLater; slack: RestLater };
}

/** The return times until the person sets any: an hour's first rest, and a day for later. */
export const RETURN_TIMES_DEFAULT: ReturnTimes = {
  read_first: { chat: REST_FIRST_DEFAULT, email: REST_FIRST_DEFAULT },
  later: { chat: REST_LATER_DEFAULT, email: REST_LATER_DEFAULT, slack: REST_LATER_DEFAULT },
};

/** Whether a value is a whole set of return times, for checking what a client, a paired Mac or the file holds. */
export function isReturnTimes(v: unknown): v is ReturnTimes {
  if (!v || typeof v !== "object") return false;
  const { read_first: first, later } = v as { read_first?: unknown; later?: unknown };
  if (!first || typeof first !== "object" || !later || typeof later !== "object") return false;
  const f = first as Record<string, unknown>;
  const l = later as Record<string, unknown>;
  return isRestFirstValue(f.chat) && isRestFirstValue(f.email) && isRestLater(l.chat) && isRestLater(l.email) && isRestLater(l.slack);
}

/** How long ⌘] first rests a card of this kind; a Slack card has no rest of its own, so it reads the default. */
export function readFirstMs(times: ReturnTimes, kind: CardKind): number {
  return REST_FIRST_CHOICES[kind === "slack" ? REST_FIRST_DEFAULT : times.read_first[kind]];
}

/** How long ⌘[ puts a card of this kind off. */
export function laterMs(times: ReturnTimes, kind: CardKind): number {
  return REST_LATER_CHOICES[times.later[kind]];
}

/** How much longer each further Next on the same card makes its rest. */
export const REST_GROWTH = 3;
/** The longest rest: every chat not archived comes past at least once a week. */
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

/** A rest's kind as sent: missing (a rest from before plan 070) or one of the two keys. */
const isRestKind = (v: unknown): boolean => v === undefined || v === "read" || v === "later";

/** Whether a value is a Rest, for checking what a client or a paired Mac sends. */
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

/** The gap of the n-th rung, capped, on a ladder whose first rung is `first`. */
export function rungMs(n: number, first: number = REST_FIRST_MS): number {
  return Math.min(REST_CAP_MS, first * REST_GROWTH ** Math.max(0, n - 1));
}

/** The rung a card's last rest left it on, while nothing new has come since; 0 once something has. */
export function rungOf(item: AttentionItem, rest: Rest | undefined): number {
  return rest?.stamp === stampOf(item) ? rest.n : 0;
}

/** The rung a read rest climbs from: a later rest counts presses of the other key, so the ladder starts over after one. */
const readRungOf = (item: AttentionItem, rest: Rest | undefined): number => (rest?.kind === "later" ? 0 : rungOf(item, rest));

/**
 * The read rest after Next (⌘]) on `item`; null for a stopped agent, which never rests. `movedOn`: the Next comes
 * straight after acting on this card (a reply), so it is moving on, not a skip. `first`: the first rung, the person's
 * setting for the card's kind. An outside card climbs the same ladder without the quiet-time term (KTD10).
 */
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

/**
 * The later rest after ⌘[ on `item`, `laterMs` from now, and whether to ask when instead (R7): from the second later
 * press in a row on a card with nothing new, the deck asks and puts the pick in `until`. Null for a stopped agent,
 * which never rests.
 */
export function restAfterLater(item: AttentionItem, prev: Rest | undefined, now: number, laterMs: number): { rest: Rest; ask: boolean } | null {
  if (isBlocked(item)) return null;
  const n = (prev?.kind === "later" ? rungOf(item, prev) : 0) + 1;
  const rest: Rest = { n, until: new Date(now + laterMs).toISOString(), stamp: stampOf(item), at: new Date(now).toISOString(), kind: "later" };
  return { rest, ask: n >= 2 };
}

/** The rest an undo leaves: over at once, on the rung (and of the kind) the card had before. */
export function restUndone(prev: Rest | undefined, now = Date.now()): Rest {
  const at = new Date(now).toISOString();
  return { n: prev?.n ?? 0, until: at, stamp: prev?.stamp ?? "", at, ...(prev?.kind ? { kind: prev.kind } : {}) };
}

/** Whether `rest` still hides `item` at `now`: not for a stopped agent, not once something new came, not after it ends. */
export function isResting(item: AttentionItem, rest: Rest | undefined, now = Date.now()): boolean {
  if (!rest || isBlocked(item)) return false;
  return rest.stamp === stampOf(item) && Date.parse(rest.until) > now;
}

/**
 * Whether an outside card rests at `now`, judged from its newest message alone, as the mod knows it: the same test as
 * isResting, which an outside card meets the same way, since it never waits on an approval or a question.
 */
export function outsideResting(rest: Rest | undefined, newestMessageId: string, now: number): boolean {
  return !!rest && rest.stamp === outsideStamp(newestMessageId) && Date.parse(rest.until) > now;
}

/**
 * A card's rest as the Inbox reads it at `now`: whether it rests, its rung, and whether it is back from a rest that
 * ended with nothing new (what the analytics measure the ladder by).
 */
export function restState(item: AttentionItem, rest: Rest | undefined, now = Date.now()): { resting: boolean; rung: number; rested: boolean } {
  const resting = isResting(item, rest, now);
  return { resting, rung: rungOf(item, rest), rested: !resting && !!rest && rest.stamp === stampOf(item) };
}

/** Whether a Next comes straight after acting on the same card (a reply, an answer): moving on, not a skip. */
export function movesOn(prev: { id: string; action: string } | null, id: string): boolean {
  return prev?.id === id && prev.action !== "next";
}
