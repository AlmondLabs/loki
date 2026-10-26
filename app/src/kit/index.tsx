import type { ComponentType } from "react";
import { lazy, Suspense, useRef, useState } from "react";

/**
 * loki widget kit v1. Every component takes the widget's `data` and an
 * `onSet(path, value)` writer that patches the shared desk store (tier 0).
 * Display components ignore onSet. See skills/loki/SKILL.md for the authoring API.
 */
export interface KitProps {
  data: Record<string, unknown>;
  onSet: (path: string, value: unknown) => void;
}

/** A value from the widget's data as text: an object or array in its JSON form, anything else as JavaScript writes it. */
function asText(v: unknown): string {
  return typeof v === "object" && v !== null ? JSON.stringify(v) : String(v);
}

/** The kit's text card: `data.lines`, one line each. */
export function InfoCard({ data }: KitProps) {
  const lines = (data.lines as string[] | undefined) ?? [];
  return (
    <div className="loki-widget-body" style={{ display: "grid", gap: 6 }}>
      {lines.map((line, i) => (
        <div key={i}>{line}</div>
      ))}
    </div>
  );
}

/** The kit's big number: `data.value` with its `unit`, a green or red `delta`, and a `label` under it. */
export function Stat({ data }: KitProps) {
  const delta = typeof data.delta === "number" ? data.delta : null;
  return (
    <div className="loki-widget-body">
      <div style={{ display: "flex", alignItems: "baseline", gap: 6 }}>
        <span style={{ fontSize: 28, fontWeight: 600, fontFamily: "var(--loki-mono)" }}>{asText(data.value ?? "—")}</span>
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

/** The kit's slider over `data.value` (with `min`, `max`, `step`, `label` and `unit`); it writes `value` once, when the drag ends, not on every step. */
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
        <span>{asText(data.label ?? "value")}</span>
        <span style={{ fontFamily: "var(--loki-mono)" }}>
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

/** The kit's checklist over `data.items`; ticking one writes `items.<i>.done`. */
export function ListCard({ data, onSet }: KitProps) {
  const items = (data.items as Array<{ text: string; done?: boolean }> | undefined) ?? [];
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

/** A chart card's height: the chart's, and its placeholder's while the chart loads, so the card does not jump. */
export const CHART_HEIGHT = 180;

const ChartView = lazy(() => import("./chart-view").then((m) => ({ default: m.ChartView })));

/**
 * The kit's chart of `data.points` (x, y), drawn as a line, a bar or an area chart by `data.kind` (line when unset).
 * `chart-view.tsx` draws it, loaded the first time a chart shows (plan 038).
 */
export function ChartCard(props: KitProps) {
  return (
    <Suspense fallback={<div className="loki-widget-body" style={{ height: CHART_HEIGHT }} />}>
      <ChartView {...props} />
    </Suspense>
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
