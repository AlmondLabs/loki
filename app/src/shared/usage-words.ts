import type { UsageOrigin } from "../../../core/usage.ts";

export function money(n: number): string {
  if (n <= 0) return "$0";
  if (n < 0.01) return "<$0.01";
  return `$${n >= 100 ? Math.round(n).toLocaleString("en") : n.toFixed(2)}`;
}

export function tokenCount(n: number): string {
  if (n < 1000) return String(Math.round(n));
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(n < 10_000_000 ? 1 : 0)}M`;
}

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
  advisor: "Advisor",
};

export const originName = (o: string): string => ORIGINS[o] ?? o;

export const modelName = (m: string): string => (m.includes("/") ? m.slice(m.indexOf("/") + 1) : m);

export const PERIODS = ["24h", "7d", "30d", "90d"] as const;
export type UsagePeriod = (typeof PERIODS)[number];
export const PERIOD_LABELS: Record<UsagePeriod, string> = { "24h": "24 hours", "7d": "7 days", "30d": "30 days", "90d": "90 days" };

export function periodStart(period: UsagePeriod, now: number): number {
  if (period === "24h") return now - 86_400_000;
  const days = Number(period.slice(0, -1));
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - (days - 1));
  return d.getTime();
}
