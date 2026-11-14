import type { KeyboardEvent, PointerEvent, ReactNode } from "react";
import { SIDEBAR_MAX, SIDEBAR_MIN } from "./columns";

/** One arrow press on the resize handle, in px. */
const KEY_STEP = 16;

/**
 * The sidebar (plan 2026-11-14-1330, R1): the places and their sources, the same rows in every place, so changing place
 * moves only the selection. It is the window's navigation landmark, "Sidebar", first in the Tab order (KTD13). Each place's items are in the list column beside it, never under the places. The right
 * edge is a separator: drag it, or focus it and use the arrows (Home / End for the ends); the width is kept when the
 * drag ends.
 */
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
  /** Where the column starts, in px: the glass sidebar's inset. */
  left: number;
  /** The column's top, in px: under the glass sidebar's row of lights. */
  top: number;
  /** The places and their sources (U12). */
  head: ReactNode;
  /** Its stacking while a folded sidebar shows over the list and the detail (columns.ts); none while it sits beside them. */
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

/**
 * A column's right edge, a separator: drag it, or focus it and use the arrows (Home / End for the ends). `onWidth`
 * gets each width as it moves and `commit` once the drag ends or a key moves it, so the width is kept then. The sidebar
 * and the list column each have one.
 */
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
  /** A hidden column's edge leaves the Tab order. */
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
