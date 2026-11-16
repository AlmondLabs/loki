import type { ComponentType } from "react";
import { lazy, Suspense, useRef, useState } from "react";

export interface KitProps {
  data: Record<string, unknown>;
  onSet: (path: string, value: unknown) => void;
}

function asText(v: unknown): string {
  return typeof v === "object" && v !== null ? JSON.stringify(v) : String(v);
}

export function InfoCard({ data }: KitProps) {
  const lines = (data.lines as string[] | undefined) ?? [];
  return (
    <div className="loki-widget-body grid gap-2">
      {lines.map((line, i) => (
        <div key={i}>{line}</div>
      ))}
    </div>
  );
}

export function Stat({ data }: KitProps) {
  const delta = typeof data.delta === "number" ? data.delta : null;
  return (
    <div className="loki-widget-body">
      <div className="flex items-baseline gap-1">
        <span className="loki-mono" style={{ fontSize: "var(--text-2xl)", fontWeight: 600 }}>
          {asText(data.value ?? "—")}
        </span>
        {typeof data.unit === "string" && <span className="loki-muted">{data.unit}</span>}
        {delta !== null && (
          <span
            style={{
              fontSize: "var(--text-xs)",
              color: delta >= 0 ? "var(--loki-positive)" : "var(--loki-negative)",
            }}
          >
            {delta >= 0 ? "▲" : "▼"} {Math.abs(delta)}
          </span>
        )}
      </div>
      {typeof data.label === "string" && (
        <div className="loki-muted" style={{ fontSize: "var(--text-xs)" }}>
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
    <div className="loki-widget-body grid gap-2">
      <div className="flex justify-between">
        <span>{asText(data.label ?? "value")}</span>
        <span className="loki-mono">
          {shown}
          {typeof data.unit === "string" ? ` ${data.unit}` : ""}
        </span>
      </div>
      <input
        className="loki-slider"
        type="range"
        aria-label={asText(data.label ?? "value")}
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
  const items = (data.items as Array<{ text: string; done?: boolean }> | undefined) ?? [];
  return (
    <div className="loki-widget-body grid gap-2">
      {items.map((item, i) => (
        <label key={i} className="flex items-center gap-2" style={{ cursor: "pointer" }}>
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
      {items.length === 0 && <span className="loki-muted">Empty list</span>}
    </div>
  );
}

export const CHART_HEIGHT = 180;

const ChartView = lazy(() => import("./chart-view").then((m) => ({ default: m.ChartView })));

export function ChartCard(props: KitProps) {
  return (
    <Suspense fallback={<div className="loki-widget-body" style={{ height: CHART_HEIGHT }} />}>
      <ChartView {...props} />
    </Suspense>
  );
}

export const KIT_COMPONENTS: Record<string, ComponentType<KitProps>> = {
  "info-card": InfoCard,
  stat: Stat,
  "slider-control": SliderControl,
  "list-card": ListCard,
  "chart-card": ChartCard,
};
