import type { UsageOrigin } from "../../../core/usage.ts";

/**
 * How the usage page says its numbers, on the Mac and the phone alike: dollars as estimates, token counts short, and
 * each origin and model by a name a person reads.
 */

/** "$4.12", "<$0.01" for a cost too small to show, "$0" for none. */
export function money(n: number): string {
  if (n <= 0) return "$0";
  if (n < 0.01) return "<$0.01";
  return `$${n >= 100 ? Math.round(n).toLocaleString("en") : n.toFixed(2)}`;
}

/** "950", "12.3k", "1.9M" tokens. */
export function tokenCount(n: number): string {
  if (n < 1000) return String(Math.round(n));
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(n < 10_000_000 ? 1 : 0)}M`;
}

/** "42%" of the period's cost, "<1%" for a sliver. */
export function shareText(share: number): string {
  if (share <= 0) return "0%";
  if (share < 0.01) return "<1%";
  return `${Math.round(share * 100)}%`;
}

const ORIGINS: Partial<Record<string, string>> & Record<UsageOrigin, string> = {
  chats: "Your chats",
  helpers: "Helpers",
  reflection: "Reflection",
  learn: "Learn",
  doctor: "Memory review",
};

/** An origin as a person reads it. */
export const originName = (o: string): string => ORIGINS[o] ?? o;

/** A model by its own id, without its provider (`anthropic/claude-sonnet-5-5` reads `claude-sonnet-5-5`). */
export const modelName = (m: string): string => (m.includes("/") ? m.slice(m.indexOf("/") + 1) : m);

/** The periods the page offers, and how many days each covers (24 hours is one day, by hour). */
export const PERIODS = ["24h", "7d", "30d", "90d"] as const;
/** One of the page's periods. */
export type UsagePeriod = (typeof PERIODS)[number];
/** Each period's label on its chip. */
export const PERIOD_LABELS: Record<UsagePeriod, string> = { "24h": "24 hours", "7d": "7 days", "30d": "30 days", "90d": "90 days" };

/**
 * Where a period starts, in ms, for one ending at `now`: 24 hours back, or the reader's midnight that many days back
 * (today counted), so each bar is a whole day.
 */
export function periodStart(period: UsagePeriod, now: number): number {
  if (period === "24h") return now - 86_400_000;
  const days = Number(period.slice(0, -1));
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - (days - 1));
  return d.getTime();
}
