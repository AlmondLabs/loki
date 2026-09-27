/**
 * Focus: which chats you have been engaging with lately, learned from what you do, never set by hand. Each
 * chat keeps a weight that your actions add to and that halves every FOCUS_HALF_LIFE_H hours; a chat's focus
 * is its share of all that weight. Working a task hard lifts its chat; starting another task takes share from
 * it at once, and a chat left alone for a few days fades to nothing, with no park button (priority.ts turns
 * the share into points).
 *
 *   w     ← w · ½^(hours since t / FOCUS_HALF_LIFE_H) + the action's weight;  t ← now
 *   share = w / (Σ w over every chat + FOCUS_CUSHION)
 *
 * The cushion is about two fresh replies: after a quiet week every share falls toward 0 instead of the one
 * chat with weight left taking the whole list. Only your actions count — never the agent's turns, never a
 * scheduled prompt — so a busy cron cannot talk its way to the top. The mod keeps the weights (mod/seen.ts),
 * so the Mac and the phone rank the same.
 */
export type FocusAction = "message" | "answer" | "decide" | "open";

/** What each action adds: a message or an answer is engagement; a decision is half; opening and reading, a quarter. */
export const FOCUS_WEIGHT: Record<FocusAction, number> = { message: 1, answer: 1, decide: 0.5, open: 0.25 };
export const FOCUS_HALF_LIFE_H = 12;
export const FOCUS_CUSHION = 2;
/** Opening the same chat again inside this window adds nothing: flicking between chats is not more engagement. */
export const FOCUS_OPEN_GAP_MS = 30 * 60_000;

export interface FocusEntry {
  /** The weight as of `t`. */
  w: number;
  /** ISO time of the last action that changed `w`. */
  t: string;
}

export const isFocusAction = (v: unknown): v is FocusAction => typeof v === "string" && v in FOCUS_WEIGHT;

/** The weight faded to `now`. */
export function decayed(e: FocusEntry, now = Date.now()): number {
  const hours = Math.max(0, now - new Date(e.t).getTime()) / 3_600_000;
  return e.w * 0.5 ** (hours / FOCUS_HALF_LIFE_H);
}

/** The entry after one action at `now`; null when it adds nothing (a repeat open inside FOCUS_OPEN_GAP_MS). */
export function addFocus(prev: FocusEntry | undefined, action: FocusAction, now = Date.now()): FocusEntry | null {
  if (action === "open" && prev && now - new Date(prev.t).getTime() < FOCUS_OPEN_GAP_MS) return null;
  return { w: (prev ? decayed(prev, now) : 0) + FOCUS_WEIGHT[action], t: new Date(now).toISOString() };
}

/** Every chat's share at `now`, by the same key as the entries ("agentId/conversationId"). */
export function focusShares(entries: Record<string, FocusEntry>, now = Date.now()): Record<string, number> {
  const w = Object.entries(entries).map(([key, e]) => [key, decayed(e, now)] as const);
  const total = w.reduce((sum, [, v]) => sum + v, 0) + FOCUS_CUSHION;
  return Object.fromEntries(w.map(([key, v]) => [key, v / total]));
}

/** Entries whose weight has faded below this are dropped when written: a month-old chat is not worth keeping. */
export const FOCUS_FORGET_BELOW = 0.001;

/** The entries still worth keeping at `now`. */
export function pruneFocus(entries: Record<string, FocusEntry>, now = Date.now()): Record<string, FocusEntry> {
  return Object.fromEntries(Object.entries(entries).filter(([, e]) => decayed(e, now) >= FOCUS_FORGET_BELOW));
}
