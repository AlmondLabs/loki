import type { AttentionItem } from "./model.ts";
import { stampOf } from "./queue.ts";

/**
 * "Later" with a memory, Anki-style: each time you defer the same card the
 * gap before it returns grows — 5m, 15m, 45m, 2h, 6h, then a day. Approvals
 * never snooze. A card that has moved on (new reply, new approval) ignores its
 * snooze and comes straight back. Everything resets at the start of a new day.
 */
export interface Snooze {
  /** How many times in a row (today) this card was deferred. */
  skips: number;
  /** ISO time it becomes due again. */
  until: string;
  /** stampOf(item) when deferred; a different stamp means new content, snooze void. */
  stamp: string;
  /** ISO time of the deferral. */
  at: string;
}

export const SNOOZE_TIERS_MS = [5, 15, 45, 120, 360, 1440].map((m) => m * 60_000);

export function sameLocalDay(iso: string, now: number): boolean {
  const a = new Date(iso);
  const b = new Date(now);
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

/** The next deferral for a card, building on today's earlier ones. */
export function nextSnooze(prev: Snooze | undefined, stamp: string, now = Date.now()): Snooze {
  const skips = (prev && sameLocalDay(prev.at, now) ? prev.skips : 0) + 1;
  const tier = SNOOZE_TIERS_MS[Math.min(skips, SNOOZE_TIERS_MS.length) - 1];
  return { skips, until: new Date(now + tier).toISOString(), stamp, at: new Date(now).toISOString() };
}

/** The snooze that currently hides this item, or null if it is due (or was never deferred). */
export function activeSnooze(item: AttentionItem, snooze: Snooze | undefined, now = Date.now()): Snooze | null {
  if (!snooze) return null;
  if (item.status === "approval" || item.pendingQuestion) return null; // never hide a blocked agent
  if (snooze.stamp !== stampOf(item)) return null; // it moved on
  if (!sameLocalDay(snooze.at, now)) return null; // new day, clean slate
  if (new Date(snooze.until).getTime() <= now) return null;
  return snooze;
}

export function ordinal(n: number): string {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return `${n}${s[(v - 20) % 10] ?? s[v] ?? s[0]}`;
}

/** "now", "4m", "2h", "1d" — how long until `iso`. */
export function formatIn(iso: string, now = Date.now()): string {
  const ms = new Date(iso).getTime() - now;
  if (ms <= 0) return "now";
  const m = Math.ceil(ms / 60_000);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}
