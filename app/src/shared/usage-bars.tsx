import type { UsagePoint } from "../../../core/usage.ts";
import { money, tokenCount } from "./usage-words";

const dayLabel = (bucket: string, weekday: boolean) =>
  new Date(`${bucket.slice(0, 10)}T12:00:00`).toLocaleDateString(undefined, { month: "short", day: "numeric", ...(weekday ? { weekday: "short" } : {}) });

export function UsageBars({ series, hourly }: { series: UsagePoint[]; hourly: boolean }) {
  const byCost = series.some((p) => p.cost > 0);
  const value = (p: UsagePoint) => (byCost ? p.cost : p.tokens);
  const top = Math.max(...series.map(value), 0);
  const label = (bucket: string) => (hourly ? `${dayLabel(bucket, false)}, ${bucket.slice(11)}:00` : dayLabel(bucket, series.length <= 7));
  return (
    <div role="img" aria-label={`${byCost ? "Cost" : "Tokens"} by ${hourly ? "hour" : "day"}`} className="grid gap-1">
      <div className="flex items-end gap-0.5" style={{ height: 64 }}>
        {series.map((p) => (
          <div
            key={p.bucket}
            title={`${label(p.bucket)}: ${money(p.cost)} · ${tokenCount(p.tokens)} tokens`}
            className="flex-1"
            style={{
              minWidth: 2,
              height: top > 0 ? `${Math.max(value(p) > 0 ? 4 : 0, (value(p) / top) * 100)}%` : 0,
              background: "var(--loki-accent)",
              borderRadius: "var(--radius-md)",
            }}
          />
        ))}
      </div>
      {series.length > 0 && (
        <div className="loki-meta flex justify-between">
          <span>{label(series[0].bucket)}</span>
          <span>{label(series[series.length - 1].bucket)}</span>
        </div>
      )}
    </div>
  );
}
