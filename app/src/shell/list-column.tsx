import { useState, type KeyboardEvent, type PointerEvent, type ReactNode } from "react";
import { SIDEBAR_MAX, SIDEBAR_MIN } from "./columns";
import type { Segment } from "./keymap";

/** One arrow press on the resize handle, in px. */
const KEY_STEP = 16;

/**
 * Slack's second column, between the rail and the main pane (plan 013 U3). Each section's body mounts on
 * its first visit and then stays, hidden with `visibility` while another section shows, so its scroll and
 * selection survive switching (the Surface's trick, KTD2). The right edge is a separator: drag it, or
 * focus it and use the arrows (Home / End for the ends); the width is kept when the drag ends.
 */
export function ListColumn({
  segment,
  shown,
  width,
  onWidth,
  sections,
  left,
  top,
  head = null,
  foot = null,
  layer,
}: {
  segment: Segment;
  shown: boolean;
  width: number;
  onWidth: (w: number, commit: boolean) => void;
  sections: Partial<Record<Segment, ReactNode>>;
  /** Where the column starts, in px: the glass sidebar's inset. */
  left: number;
  /** The column's top, in px: under the glass sidebar's row of lights. */
  top: number;
  /** Rows above every section's body: the places (U12). */
  head?: ReactNode;
  /** Rows under every section's body: the update notice. */
  foot?: ReactNode;
  /** Its stacking while a folded sidebar shows over the list and the detail (columns.ts); none while it sits beside them. */
  layer?: number;
}) {
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
    const next =
      e.key === "ArrowLeft"
        ? width - KEY_STEP
        : e.key === "ArrowRight"
          ? width + KEY_STEP
          : e.key === "Home"
            ? SIDEBAR_MIN
            : e.key === "End"
              ? SIDEBAR_MAX
              : null;
    if (next === null) return;
    e.preventDefault();
    onWidth(next, true);
  };

  return (
    <aside
      className="loki-column"
      aria-label="Sidebar"
      aria-hidden={!shown}
      onPointerDown={(e) => e.stopPropagation()}
      style={{ top, left, width, zIndex: layer, visibility: shown ? "visible" : "hidden" }}
    >
      {head}
      <div className="loki-column-bodies">
        {[...mounted].map((s) => (
          <div key={s} className="loki-column-body" style={{ visibility: shown && s === segment ? "visible" : "hidden" }} aria-hidden={s !== segment}>
            {sections[s]}
          </div>
        ))}
      </div>
      {foot}
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize sidebar"
        aria-valuemin={SIDEBAR_MIN}
        aria-valuemax={SIDEBAR_MAX}
        aria-valuenow={width}
        tabIndex={shown ? 0 : -1}
        className="loki-column-edge"
        onPointerDown={onPointerDown}
        onKeyDown={onKeyDown}
      />
    </aside>
  );
}

/** The column's top line, level with the main pane's header: the section's name and its actions. It drags the window like the pane header's name line. */
export function ColumnHeader({ title, actions, quiet = false }: { title: ReactNode; actions?: ReactNode; quiet?: boolean }) {
  return (
    <div className="loki-column-header" data-quiet={quiet || undefined} data-tauri-drag-region="deep">
      {/* Quiet: the place's own row above already says it, as Mail's sidebar never names a mailbox twice; a screen reader still hears it. */}
      <h2 className={quiet ? "loki-column-title sr-only" : "loki-column-title"}>{title}</h2>
      {actions && <span className="loki-column-actions">{actions}</span>}
    </div>
  );
}
