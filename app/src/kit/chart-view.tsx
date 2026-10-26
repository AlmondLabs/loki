import { useMemo } from "react";
import { Area, AreaChart, Bar, BarChart, CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { CHART_HEIGHT, type KitProps } from "./index";

/**
 * The kit's chart of `data.points` (x, y), drawn as a line, a bar or an area chart by `data.kind` (line when unset).
 * A module of its own so `recharts`, the biggest package the page has, loads only when a chart card shows (plan 038).
 */
export function ChartView({ data }: KitProps) {
  const points = useMemo(() => ((data.points as Array<{ x: string | number; y: number }> | undefined) ?? []).map((p) => ({ ...p })), [data.points]);
  const kind = (data.kind as string | undefined) ?? "line";
  const common = {
    data: points,
    margin: { top: 8, right: 8, bottom: 0, left: -18 },
  };
  const axes = (
    <>
      <CartesianGrid stroke="var(--loki-border)" strokeDasharray="3 3" />
      <XAxis dataKey="x" stroke="var(--loki-muted)" fontSize={11} tickLine={false} />
      <YAxis stroke="var(--loki-muted)" fontSize={11} tickLine={false} />
      <Tooltip
        contentStyle={{
          background: "var(--loki-panel)",
          border: "1px solid var(--loki-border)",
          borderRadius: "var(--loki-radius-md)",
          fontSize: 12,
        }}
      />
    </>
  );
  return (
    <div className="loki-widget-body" style={{ height: CHART_HEIGHT }}>
      <ResponsiveContainer width="100%" height="100%">
        {kind === "bar" ? (
          <BarChart {...common}>
            {axes}
            <Bar dataKey="y" fill="var(--loki-accent)" radius={[3, 3, 0, 0]} />
          </BarChart>
        ) : kind === "area" ? (
          <AreaChart {...common}>
            {axes}
            <Area dataKey="y" stroke="var(--loki-accent)" fill="var(--loki-accent-soft)" />
          </AreaChart>
        ) : (
          <LineChart {...common}>
            {axes}
            <Line dataKey="y" stroke="var(--loki-accent)" dot={false} strokeWidth={2} />
          </LineChart>
        )}
      </ResponsiveContainer>
    </div>
  );
}
