export type FocusAction = "message" | "answer" | "decide" | "open";

export const FOCUS_WEIGHT: Record<FocusAction, number> = { message: 1, answer: 1, decide: 0.5, open: 0.25 };
export const FOCUS_HALF_LIFE_H = 12;
export const FOCUS_CUSHION = 2;
export const FOCUS_OPEN_GAP_MS = 30 * 60_000;

/** One chat's focus weight as the mod keeps it (mod/seen.ts), faded from `t` when read. */
export interface FocusEntry {
  /** The weight as of `t`. */
  w: number;
  /** ISO time of the last action that changed `w`. */
  t: string;
}

export function decayed(e: FocusEntry, now = Date.now()): number {
  const hours = Math.max(0, now - new Date(e.t).getTime()) / 3_600_000;
  return e.w * 0.5 ** (hours / FOCUS_HALF_LIFE_H);
}

export function addFocus(prev: FocusEntry | undefined, action: FocusAction, now = Date.now()): FocusEntry | null {
  if (action === "open" && prev && now - new Date(prev.t).getTime() < FOCUS_OPEN_GAP_MS) return null;
  return { w: (prev ? decayed(prev, now) : 0) + FOCUS_WEIGHT[action], t: new Date(now).toISOString() };
}

export function focusShares(entries: Record<string, FocusEntry>, now = Date.now()): Record<string, number> {
  const w = Object.entries(entries).map(([key, e]) => [key, decayed(e, now)] as const);
  const total = w.reduce((sum, [, v]) => sum + v, 0) + FOCUS_CUSHION;
  return Object.fromEntries(w.map(([key, v]) => [key, v / total]));
}

export function combineFocus(own: Record<string, FocusEntry>, others: Array<Record<string, FocusEntry>>, now = Date.now()): Record<string, FocusEntry> {
  const t = new Date(now).toISOString();
  const sum = new Map<string, number>();
  for (const map of [own, ...others]) for (const [key, e] of Object.entries(map)) sum.set(key, (sum.get(key) ?? 0) + decayed(e, now));
  return Object.fromEntries([...sum].map(([key, w]) => [key, { w, t }]));
}

export const FOCUS_FORGET_BELOW = 0.001;

export function pruneFocus(entries: Record<string, FocusEntry>, now = Date.now()): Record<string, FocusEntry> {
  return Object.fromEntries(Object.entries(entries).filter(([, e]) => decayed(e, now) >= FOCUS_FORGET_BELOW));
}
