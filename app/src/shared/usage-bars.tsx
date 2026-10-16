import type { UsagePoint } from "../../../core/usage.ts";
import { money, tokenCount } from "./usage-words";

/** A bar's day as the reader says it ("Oct 17", or "Sat, Oct 17" for a week's bars); `bucket` starts `2026-10-17`. */
const dayLabel = (bucket: string, weekday: boolean) =>
  new Date(`${bucket.slice(0, 10)}T12:00:00`).toLocaleDateString(undefined, { month: "short", day: "numeric", ...(weekday ? { weekday: "short" } : {}) });

/** The period's bars, each a day (or an hour), its height its cost, or its tokens when nothing had a cost. */
export function UsageBars({ series, hourly }: { series: UsagePoint[]; hourly: boolean }) {
  const byCost = series.some((p) => p.cost > 0);
  const value = (p: UsagePoint) => (byCost ? p.cost : p.tokens);
  const top = Math.max(...series.map(value), 0);
  // An hour says its day too: a day's bars run from one midnight to the next.
  const label = (bucket: string) => (hourly ? `${dayLabel(bucket, false)}, ${bucket.slice(11)}:00` : dayLabel(bucket, series.length <= 7));
  return (
    <div role="img" aria-label={`${byCost ? "Cost" : "Tokens"} by ${hourly ? "hour" : "day"}`} style={{ display: "grid", gap: 4 }}>
      <div style={{ display: "flex", alignItems: "flex-end", gap: 2, height: 64 }}>
        {series.map((p) => (
          <div
            key={p.bucket}
            title={`${label(p.bucket)}: ${money(p.cost)} · ${tokenCount(p.tokens)} tokens`}
            style={{
              flex: 1,
              minWidth: 2,
              height: top > 0 ? `${Math.max(value(p) > 0 ? 4 : 0, (value(p) / top) * 100)}%` : 0,
              background: "var(--loki-accent)",
              borderRadius: "var(--loki-radius-sm)",
            }}
          />
        ))}
      </div>
      {series.length > 0 && (
        <div className="loki-meta" style={{ display: "flex", justifyContent: "space-between" }}>
          <span>{label(series[0].bucket)}</span>
          <span>{label(series[series.length - 1].bucket)}</span>
        </div>
      )}
    </div>
  );
}
