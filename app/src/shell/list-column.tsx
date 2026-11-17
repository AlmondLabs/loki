import type { KeyboardEvent, PointerEvent, ReactNode } from "react";
import { SIDEBAR_MAX, SIDEBAR_MIN } from "./columns";

const KEY_STEP = 16;

export function ListColumn({
  shown,
  width,
  onWidth,
  left,
  top,
  head,
  layer,
}: {
  shown: boolean;
  width: number;
  onWidth: (w: number, commit: boolean) => void;
  left: number;
  top: number;
  head: ReactNode;
  layer?: number;
}) {
  return (
    <nav
      className="loki-column"
      aria-label="Sidebar"
      aria-hidden={!shown}
      onPointerDown={(e) => e.stopPropagation()}
      style={{ top, left, width, zIndex: layer, visibility: shown ? "visible" : "hidden" }}
    >
      {head}
      <ColumnEdge label="Resize sidebar" min={SIDEBAR_MIN} max={SIDEBAR_MAX} width={width} onWidth={onWidth} shown={shown} />
    </nav>
  );
}

export function ColumnEdge({
  label,
  min,
  max,
  width,
  onWidth,
  shown = true,
}: {
  label: string;
  min: number;
  max: number;
  width: number;
  onWidth: (w: number, commit: boolean) => void;
  shown?: boolean;
}) {
  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const handle = e.currentTarget;
    handle.setPointerCapture(e.pointerId);
    const startX = e.clientX;
    const startW = width;
    const at = (ev: globalThis.PointerEvent) => startW + ev.clientX - startX;
    const move = (ev: globalThis.PointerEvent) => onWidth(at(ev), false);
    const up = (ev: globalThis.PointerEvent) => {
      onWidth(at(ev), true);
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", up);
      handle.removeEventListener("pointercancel", up);
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up);
    handle.addEventListener("pointercancel", up);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const next = e.key === "ArrowLeft" ? width - KEY_STEP : e.key === "ArrowRight" ? width + KEY_STEP : e.key === "Home" ? min : e.key === "End" ? max : null;
    if (next === null) return;
    e.preventDefault();
    onWidth(next, true);
  };
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={width}
      tabIndex={shown ? 0 : -1}
      className="loki-column-edge"
      onPointerDown={onPointerDown}
      onKeyDown={onKeyDown}
    />
  );
}
