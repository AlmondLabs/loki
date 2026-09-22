
import type { ComponentType } from "react";
import { useMemo, useRef, useState } from "react";
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
 * loki widget kit v1. Every component takes the widget's `data` and an
 * `onSet(path, value)` writer that patches the shared desk store (tier 0).
 * Display components ignore onSet. See skills/loki/SKILL.md for the authoring API.
 */
export interface KitProps {
  data: Record<string, unknown>;
  onSet: (path: string, value: unknown) => void;
}

export function InfoCard({ data }: KitProps) {
  const lines = (data.lines as string[]) ?? [];
  return (
    <div className="loki-widget-body" style={{ display: "grid", gap: 6 }}>
      {lines.map((line, i) => (
        <div key={i}>{line}</div>
      ))}
    </div>
  );
}

export function Stat({ data }: KitProps) {
  const delta = typeof data.delta === "number" ? (data.delta as number) : null;
  return (
    <div className="loki-widget-body">
      <div style={{ display: "flex", alignItems: "baseline", gap: 6 }}>
        <span style={{ fontSize: 28, fontWeight: 600, fontFamily: "var(--loki-mono)" }}>
          {String(data.value ?? "—")}
        </span>
        {typeof data.unit === "string" && <span className="loki-muted">{data.unit}</span>}
        {delta !== null && (
          <span
            style={{
              fontSize: 12,
              color: delta >= 0 ? "var(--loki-positive)" : "var(--loki-negative)",
            }}
          >
            {delta >= 0 ? "▲" : "▼"} {Math.abs(delta)}
          </span>
        )}
      </div>
      {typeof data.label === "string" && (
        <div className="loki-muted" style={{ fontSize: 12 }}>
          {data.label}
        </div>
      )}
    </div>
  );
}

export function SliderControl({ data, onSet }: KitProps) {
  const value = Number(data.value ?? 0);
  const [live, setLive] = useState<number | null>(null);
  const liveRef = useRef<number | null>(null);
  const pointerActive = useRef(false);
  const shown = live ?? value;
  const commit = () => {
    if (liveRef.current === null) return;
    onSet("value", liveRef.current);
    liveRef.current = null;
    setLive(null);
  };
  return (
    <div className="loki-widget-body" style={{ display: "grid", gap: 8 }}>
      <div style={{ display: "flex", justifyContent: "space-between" }}>
        <span>{String(data.label ?? "value")}</span>
        <span style={{ fontFamily: "var(--loki-mono)" }}>
          {shown}
          {typeof data.unit === "string" ? ` ${data.unit}` : ""}
        </span>
      </div>
      <input
        className="loki-slider"
        type="range"
        aria-label={String(data.label ?? "value")}
        min={Number(data.min ?? 0)}
        max={Number(data.max ?? 100)}
        step={Number(data.step ?? 1)}
        value={shown}
        onPointerDown={() => {
          pointerActive.current = true;
        }}
        onChange={(e) => {
          const next = Number(e.target.value);
          liveRef.current = next;
          setLive(next);
          if (!pointerActive.current) commit();
        }}
        onPointerUp={() => {
          pointerActive.current = false;
          commit();
        }}
        onPointerCancel={() => {
          pointerActive.current = false;
          commit();
        }}
        onBlur={() => {
          pointerActive.current = false;
          commit();
        }}
      />
    </div>
  );
}

export function ListCard({ data, onSet }: KitProps) {
  const items = (data.items as Array<{ text: string; done?: boolean }>) ?? [];
  return (
    <div className="loki-widget-body" style={{ display: "grid", gap: 6 }}>
      {items.map((item, i) => (
        <label key={i} style={{ display: "flex", gap: 8, alignItems: "center", cursor: "pointer" }}>
          <input
            type="checkbox"
            checked={!!item.done}
            onChange={(e) => onSet(`items.${i}.done`, e.target.checked)}
            style={{ accentColor: "var(--loki-accent)" }}
          />
          <span
            style={{
              textDecoration: item.done ? "line-through" : "none",
              color: item.done ? "var(--loki-muted)" : "var(--loki-fg)",
            }}
          >
            {item.text}
          </span>
        </label>
      ))}
      {items.length === 0 && <span className="loki-muted">empty list</span>}
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
      <CartesianGrid stroke="var(--loki-border)" strokeDasharray="3 3" />
      <XAxis dataKey="x" stroke="var(--loki-muted)" fontSize={11} tickLine={false} />
      <YAxis stroke="var(--loki-muted)" fontSize={11} tickLine={false} />
      <Tooltip
        contentStyle={{
          background: "var(--loki-panel)",
          border: "1px solid var(--loki-border)",
          borderRadius: 8,
          fontSize: 12,
        }}
      />
    </>
  );
  return (
    <div className="loki-widget-body" style={{ height: 180 }}>
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

/** type → component registry; Surface renders from this. */
export const KIT_COMPONENTS: Record<string, ComponentType<KitProps>> = {
  "info-card": InfoCard,
  stat: Stat,
  "slider-control": SliderControl,
  "list-card": ListCard,
  "chart-card": ChartCard,
};
