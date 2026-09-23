import { useState, type KeyboardEvent, type PointerEvent, type ReactNode } from "react";
import { COLUMN_MAX, COLUMN_MIN } from "./column";
import type { Segment } from "./keymap";
import { SIDEBAR_WIDTH, TITLEBAR_HEIGHT } from "./Sidebar";

/** One arrow press on the resize handle, in px. */
const KEY_STEP = 16;

/**
 * Slack's second column, between the rail and the main pane (plan 013 U3). Each section's body mounts on
 * its first visit and then stays, hidden with `visibility` while another section shows, so its scroll and
 * selection survive switching (the Surface's trick, KTD2). The right edge is a separator: drag it, or
 * focus it and use the arrows (Home / End for the ends); the width is kept when the drag ends.
 */
export function ListColumn({ segment, shown, width, onWidth, sections }: { segment: Segment; shown: boolean; width: number; onWidth: (w: number, commit: boolean) => void; sections: Partial<Record<Segment, ReactNode>> }) {
  // Which bodies have mounted: set during render (the React pattern for state derived from a prop), so the showing one mounts on the same pass.
  const [mounted, setMounted] = useState<ReadonlySet<Segment>>(() => new Set(shown ? [segment] : []));
  if (shown && !mounted.has(segment)) setMounted(new Set(mounted).add(segment));

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
    const next = e.key === "ArrowLeft" ? width - KEY_STEP : e.key === "ArrowRight" ? width + KEY_STEP : e.key === "Home" ? COLUMN_MIN : e.key === "End" ? COLUMN_MAX : null;
    if (next === null) return;
    e.preventDefault();
    onWidth(next, true);
  };

  return (
    <aside className="loki-column" aria-label="Sidebar" aria-hidden={!shown} onPointerDown={(e) => e.stopPropagation()} style={{ top: TITLEBAR_HEIGHT, left: SIDEBAR_WIDTH, width, visibility: shown ? "visible" : "hidden" }}>
      {[...mounted].map((s) => (
        <div key={s} className="loki-column-body" style={{ visibility: shown && s === segment ? "visible" : "hidden" }} aria-hidden={s !== segment}>
          {sections[s]}
        </div>
      ))}
      <div role="separator" aria-orientation="vertical" aria-label="Resize sidebar" aria-valuemin={COLUMN_MIN} aria-valuemax={COLUMN_MAX} aria-valuenow={width} tabIndex={shown ? 0 : -1} className="loki-column-edge" onPointerDown={onPointerDown} onKeyDown={onKeyDown} />
    </aside>
  );
}

/** The column's top line, level with the main pane's header: the section's name and its actions. It drags the window like the pane header's name line. */
export function ColumnHeader({ title, actions }: { title: ReactNode; actions?: ReactNode }) {
  return (
    <div className="loki-column-header" data-tauri-drag-region="deep">
      <h2 className="loki-column-title">{title}</h2>
      {actions && <span className="loki-column-actions">{actions}</span>}
    </div>
  );
}
