import "./tokens.css";
import type { ComponentType } from "react";
import { useMemo, useState } from "react";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

/**
 * loci widget kit v1. Every component takes the widget's `data` and an
 * `onSet(path, value)` writer that patches the shared desk store (tier 0).
 * Display components ignore onSet. See docs/kit.md for the authoring API.
 */
export interface KitProps {
  data: Record<string, unknown>;
  onSet: (path: string, value: unknown) => void;
}

export function InfoCard({ data }: KitProps) {
  const lines = (data.lines as string[]) ?? [];
  return (
    <div className="loci-widget-body" style={{ display: "grid", gap: 6 }}>
      {lines.map((line, i) => (
        <div key={i}>{line}</div>
      ))}
    </div>
  );
}

export function Stat({ data }: KitProps) {
  const delta = typeof data.delta === "number" ? (data.delta as number) : null;
  return (
    <div className="loci-widget-body">
      <div style={{ display: "flex", alignItems: "baseline", gap: 6 }}>
        <span style={{ fontSize: 28, fontWeight: 600, fontFamily: "var(--loci-mono)" }}>
          {String(data.value ?? "—")}
        </span>
        {typeof data.unit === "string" && <span className="loci-muted">{data.unit}</span>}
        {delta !== null && (
          <span
            style={{
              fontSize: 12,
              color: delta >= 0 ? "var(--loci-positive)" : "var(--loci-negative)",
            }}
          >
            {delta >= 0 ? "▲" : "▼"} {Math.abs(delta)}
          </span>
        )}
      </div>
      {typeof data.label === "string" && (
        <div className="loci-muted" style={{ fontSize: 12 }}>
          {data.label}
        </div>
      )}
    </div>
  );
}

export function SliderControl({ data, onSet }: KitProps) {
  const value = Number(data.value ?? 0);
  const [live, setLive] = useState<number | null>(null);
  const shown = live ?? value;
  return (
    <div className="loci-widget-body" style={{ display: "grid", gap: 8 }}>
      <div style={{ display: "flex", justifyContent: "space-between" }}>
        <span>{String(data.label ?? "value")}</span>
        <span style={{ fontFamily: "var(--loci-mono)" }}>
          {shown}
          {typeof data.unit === "string" ? ` ${data.unit}` : ""}
        </span>
      </div>
      <input
        className="loci-slider"
        type="range"
        min={Number(data.min ?? 0)}
        max={Number(data.max ?? 100)}
        step={Number(data.step ?? 1)}
        value={shown}
        onChange={(e) => setLive(Number(e.target.value))}
        onPointerUp={() => {
          if (live !== null) {
            onSet("value", live);
            setLive(null);
          }
        }}
      />
    </div>
  );
}

export function ListCard({ data, onSet }: KitProps) {
  const items = (data.items as Array<{ text: string; done?: boolean }>) ?? [];
  return (
    <div className="loci-widget-body" style={{ display: "grid", gap: 6 }}>
      {items.map((item, i) => (
        <label key={i} style={{ display: "flex", gap: 8, alignItems: "center", cursor: "pointer" }}>
          <input
            type="checkbox"
            checked={!!item.done}
            onChange={(e) => onSet(`items.${i}.done`, e.target.checked)}
            style={{ accentColor: "var(--loci-accent)" }}
          />
          <span
            style={{
              textDecoration: item.done ? "line-through" : "none",
              color: item.done ? "var(--loci-muted)" : "var(--loci-fg)",
            }}
          >
            {item.text}
          </span>
        </label>
      ))}
      {items.length === 0 && <span className="loci-muted">empty list</span>}
    </div>
  );
}

export function ChartCard({ data }: KitProps) {
  const points = useMemo(
    () => ((data.points as Array<{ x: string | number; y: number }>) ?? []).map((p) => ({ ...p })),
    [data.points],
  );
  const kind = (data.kind as string) ?? "line";
  const common = {
    data: points,
    margin: { top: 8, right: 8, bottom: 0, left: -18 },
  };
  const axes = (
    <>
      <CartesianGrid stroke="var(--loci-border)" strokeDasharray="3 3" />
      <XAxis dataKey="x" stroke="var(--loci-muted)" fontSize={11} tickLine={false} />
      <YAxis stroke="var(--loci-muted)" fontSize={11} tickLine={false} />
      <Tooltip
        contentStyle={{
          background: "var(--loci-panel)",
          border: "1px solid var(--loci-border)",
          borderRadius: 8,
          fontSize: 12,
        }}
      />
    </>
  );
  return (
    <div className="loci-widget-body" style={{ height: 180 }}>
      <ResponsiveContainer width="100%" height="100%">
        {kind === "bar" ? (
          <BarChart {...common}>
            {axes}
            <Bar dataKey="y" fill="var(--loci-accent)" radius={[3, 3, 0, 0]} />
          </BarChart>
        ) : kind === "area" ? (
          <AreaChart {...common}>
            {axes}
            <Area dataKey="y" stroke="var(--loci-accent)" fill="var(--loci-accent-soft)" />
          </AreaChart>
        ) : (
          <LineChart {...common}>
            {axes}
            <Line dataKey="y" stroke="var(--loci-accent)" dot={false} strokeWidth={2} />
          </LineChart>
        )}
      </ResponsiveContainer>
    </div>
  );
}

/** type → component registry; Surface renders from this. */
export const KIT_COMPONENTS: Record<string, ComponentType<KitProps>> = {
  "info-card": InfoCard,
  stat: Stat,
  "slider-control": SliderControl,
  "list-card": ListCard,
  "chart-card": ChartCard,
};
