/**
 * Rest: Next on a stale Inbox card hides it for a while, longer each time (plan 026). A stale card has nothing new,
 * no approval and no question; the n-th Next on it in a row rests it for
 *
 *   rest = min(REST_CAP_MS, max(REST_FIRST_MS · REST_GROWTH^(n − 1), how long the chat has been quiet))
 *
 * so a chat just worked in comes back in ten minutes and a chat quiet for two days stays away two days more. Next on a
 * card with something new reads it and rests it for the first rung only, without climbing; so does a Next straight
 * after replying on the same card, which is moving on. A stopped agent (an approval, a question) never rests.
 *
 * Each rest is kept with the card's content stamp (queue.ts stampOf). Anything new in the chat changes the stamp,
 * which ends the rest and starts the ladder again: the agent's next message, question or approval, and so whatever the
 * person sends, which starts a turn. Opening or reading the chat changes nothing, so a card read and set aside keeps
 * resting. The mod keeps every chat's rest (mod/seen.ts), so the Mac, the phone and paired Macs see the same Inbox.
 */
import type { AttentionItem } from "./model.ts";
import { isBlocked } from "./priority.ts";
import { stampOf } from "./queue.ts";

/** How long the first rest lasts: inside a pass, so an agent still at work comes back once it is done. */
export const REST_FIRST_MS = 10 * 60_000;
/** How much longer each further Next on the same card makes its rest. */
export const REST_GROWTH = 3;
/** The longest rest: every chat not archived comes past at least once a week. */
export const REST_CAP_MS = 7 * 24 * 60 * 60_000;

/** One chat's rest, as the mod keeps it ("agentId/conversationId" → Rest). */
export interface Rest {
  /** The rung: how many Nexts in a row on this card while nothing new came, 0 for a first-rung rest that did not climb. */
  n: number;
  /** ISO time the card comes back. */
  until: string;
  /** stampOf(item) when it was rested: a different stamp means something new, and the rest is over. */
  stamp: string;
  /** ISO time it was set: between Macs the later one wins. */
  at: string;
}

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
    typeof r.at === "string"
  );
}

/** The gap of the n-th rung, capped. */
export function rungMs(n: number): number {
  return Math.min(REST_CAP_MS, REST_FIRST_MS * REST_GROWTH ** Math.max(0, n - 1));
}

/** The rung a card's last rest left it on, while nothing new has come since; 0 once something has. */
export function rungOf(item: AttentionItem, rest: Rest | undefined): number {
  return rest?.stamp === stampOf(item) ? rest.n : 0;
}

/**
 * The rest after Next on `item`; null for a stopped agent, which never rests. `movedOn`: the Next comes straight after
 * acting on this card (a reply), so it is moving on, not a skip.
 */
export function restAfterNext(item: AttentionItem, prev: Rest | undefined, movedOn: boolean, now = Date.now()): Rest | null {
  if (isBlocked(item)) return null;
  const stamp = stampOf(item);
  const rung = rungOf(item, prev);
  const climbs = !item.unread && !movedOn;
  const n = climbs ? rung + 1 : rung;
  const quiet = item.last_message_at ? Math.max(0, now - Date.parse(item.last_message_at)) : 0;
  const gap = climbs ? Math.min(REST_CAP_MS, Math.max(rungMs(n), quiet)) : REST_FIRST_MS;
  return { n, until: new Date(now + gap).toISOString(), stamp, at: new Date(now).toISOString() };
}

/** The rest an undo leaves: over at once, on the rung the card had before. */
export function restUndone(prev: Rest | undefined, now = Date.now()): Rest {
  const at = new Date(now).toISOString();
  return { n: prev?.n ?? 0, until: at, stamp: prev?.stamp ?? "", at };
}

/** Whether `rest` still hides `item` at `now`: not for a stopped agent, not once something new came, not after it ends. */
export function isResting(item: AttentionItem, rest: Rest | undefined, now = Date.now()): boolean {
  if (!rest || isBlocked(item)) return false;
  return rest.stamp === stampOf(item) && Date.parse(rest.until) > now;
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
