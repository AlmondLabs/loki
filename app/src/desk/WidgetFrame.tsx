import { useEffect, useRef, type ReactNode } from "react";
import type { Gesture, Size, WidgetLayout, WidgetManifestEntry } from "../../../core/desk-core.ts";
import { MIN_FRAME, RESIZE_MIN, WIDGET_MAX_WIDTH } from "../../../core/desk-core.ts";
import { Dot, IconButton } from "../components";
import { useFrameKeyboard } from "./useFrameKeyboard";

/**
 * Standard widget chrome: drag by the title bar, close, focus-to-front, an
 * error dot when the file is broken. Pointer events stop here so the surface
 * never mistakes them for panning. The frame itself takes focus: arrows nudge
 * it, Alt+arrows resize it, Enter frames it in the camera, Escape lets go.
 */
export function WidgetFrame({
  entry,
  layout,
  highlighted = false,
  order = 0,
  gesture,
  onMeasure,
  onFocus,
  onTrash,
  getScale,
  children,
}: {
  entry: WidgetManifestEntry;
  layout: WidgetLayout;
  /** The camera is pointing here: accent ring that fades when it moves on. */
  highlighted?: boolean;
  /** Position in the desk's render order; staggers the settle-in animation. */
  order?: number;
  gesture: (g: Gesture) => void;
  /** Rendered size, so the mod can place new widgets around this one. */
  onMeasure?: (id: string, size: Size) => void;
  /** Bring this widget front, centre and large. */
  onFocus?: (id: string) => void;
  /** Delete the widget's file. */
  onTrash?: (id: string) => void;
  getScale?: () => number;
  children: ReactNode;
}) {
  const dragRef = useRef<{ startX: number; startY: number; origX: number; origY: number } | null>(null);
  const resizeRef = useRef<{ startX: number; startY: number; origW: number; origH: number } | null>(null);
  const frameRef = useRef<HTMLDivElement>(null);
  const lastSent = useRef(0);
  const sized = layout.sized === true && !!layout.size;
  // The measurement observer reads these live, so a resize in progress (or just committed) never lets a
  // trailing content measurement overwrite the width the human just pinned.
  const sizedRef = useRef(sized);
  useEffect(() => {
    sizedRef.current = sized;
  });

  const { onKeyDown, announcement } = useFrameKeyboard({ entry, layout, sized, gesture, onFocus, frameRef, lastSentRef: lastSent });

  // Report the rendered size (canvas units: offsetWidth/Height ignore the viewport transform).
  useEffect(() => {
    const el = frameRef.current;
    if (!el || !onMeasure || sized) return; // a user-sized frame reports nothing: its size is the human's, not the content's
    let last = { w: 0, h: 0 };
    const report = () => {
      if (sizedRef.current || resizeRef.current) return; // a resize is in flight or done: don't fight the human
      const w = el.offsetWidth;
      const h = el.offsetHeight;
      if (Math.abs(w - last.w) < 2 && Math.abs(h - last.h) < 2) return;
      last = { w, h };
      if (w < MIN_FRAME.w || h < MIN_FRAME.h) {
        console.warn("loki: ignoring collapsed frame measurement", entry.id, { w, h });
        return;
      }
      onMeasure(entry.id, { w, h });
    };
    report();
    const ro = new ResizeObserver(report);
    ro.observe(el);
    return () => ro.disconnect();
  }, [entry.id, onMeasure, sized]);

  const dragPosition = (d: NonNullable<typeof dragRef.current>, e: React.PointerEvent) => {
    const scale = getScale?.() ?? 1;
    return { x: d.origX + (e.clientX - d.startX) / scale, y: d.origY + (e.clientY - d.startY) / scale };
  };

  // While dragging, move the frame directly (every pointer event, no React re-render) and
  // send throttled moves for other tabs; the final position is committed on release.
  const onDragStart = (e: React.PointerEvent) => {
    e.preventDefault();
    try {
      (e.target as Element).setPointerCapture(e.pointerId);
    } catch {
      // synthetic or already-released pointer; dragging still works within the element
    }
    dragRef.current = { startX: e.clientX, startY: e.clientY, origX: layout.position.x, origY: layout.position.y };
    if (frameRef.current) frameRef.current.style.willChange = "transform"; // only while dragging
  };
  const onDragMove = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    const p = dragPosition(d, e);
    const el = frameRef.current;
    if (el) el.style.transform = `translate3d(${p.x - layout.position.x}px, ${p.y - layout.position.y}px, 0)`;
    const now = performance.now();
    if (now - lastSent.current > 50) {
      lastSent.current = now;
      gesture({ kind: "move", id: entry.id, position: p });
    }
  };
  const onDragEnd = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    dragRef.current = null;
    if (frameRef.current) {
      frameRef.current.style.transform = "";
      frameRef.current.style.willChange = "";
    }
    gesture({ kind: "move", id: entry.id, position: dragPosition(d, e) });
  };

  // The resize handle at the bottom-right: drag to pin a width and height; the content then scrolls inside.
  const onResizeStart = (e: React.PointerEvent) => {
    e.stopPropagation();
    e.preventDefault();
    try {
      (e.target as Element).setPointerCapture(e.pointerId);
    } catch {
      // fine without capture
    }
    const w = frameRef.current?.offsetWidth ?? layout.size?.w ?? 280;
    const h = frameRef.current?.offsetHeight ?? layout.size?.h ?? 160;
    resizeRef.current = { startX: e.clientX, startY: e.clientY, origW: w, origH: h };
  };
  const onResizeMove = (e: React.PointerEvent) => {
    const r = resizeRef.current;
    if (!r) return;
    const scale = getScale?.() ?? 1;
    const w = Math.max(RESIZE_MIN.w, r.origW + (e.clientX - r.startX) / scale);
    const h = Math.max(RESIZE_MIN.h, r.origH + (e.clientY - r.startY) / scale);
    const el = frameRef.current;
    if (el) {
      el.style.width = `${Math.round(w)}px`;
      el.style.height = `${Math.round(h)}px`;
    }
  };
  const onResizeEnd = (e: React.PointerEvent) => {
    const r = resizeRef.current;
    if (!r) return;
    resizeRef.current = null;
    const scale = getScale?.() ?? 1;
    const w = Math.round(Math.max(RESIZE_MIN.w, r.origW + (e.clientX - r.startX) / scale));
    const h = Math.round(Math.max(RESIZE_MIN.h, r.origH + (e.clientY - r.startY) / scale));
    gesture({ kind: "resize", id: entry.id, size: { w, h } });
  };

  return (
    <div
      ref={frameRef}
      id={`widget-${entry.id.replace("/", "--")}`}
      className="loki-frame loki-no-pan"
      tabIndex={0}
      role="group"
      aria-label={`widget ${entry.title}`}
      onKeyDown={onKeyDown}
      onPointerDown={(e) => {
        e.stopPropagation();
        gesture({ kind: "focus", id: entry.id });
      }}
      style={{
        position: "absolute",
        left: layout.position.x,
        top: layout.position.y,
        zIndex: layout.z,
        // A human-sized frame keeps its width and height. Otherwise it sizes to its content up to a
        // reading width, then the content scrolls — never clipped, never a fixed measurement of itself.
        ...(sized
          ? { width: layout.size!.w, height: layout.size!.h }
          : { width: "fit-content", minWidth: MIN_FRAME.w, maxWidth: WIDGET_MAX_WIDTH }),
        background: "var(--loki-panel)",
        border: `1px solid ${entry.error ? "var(--loki-negative)" : highlighted ? "var(--loki-accent)" : "var(--loki-border)"}`,
        borderRadius: "var(--loki-radius)",
        animationDelay: `${Math.min(order, 12) * 35}ms`,
        boxShadow: highlighted
          ? "0 0 0 3px var(--loki-brass-soft), 0 0 40px 4px var(--loki-brass-glow), var(--loki-shadow-panel)"
          : "var(--loki-shadow-panel)",
        transition: "box-shadow 500ms ease-out, border-color 500ms ease-out",
        overflow: "hidden",
        userSelect: "none",
        display: "flex",
        flexDirection: "column",
      }}
    >
      <FrameTitleBar entry={entry} gesture={gesture} onFocus={onFocus} onTrash={onTrash} onDragStart={onDragStart} onDragMove={onDragMove} onDragEnd={onDragEnd} />
      <div className="loki-frame-body" style={{ padding: 12, minHeight: 0, ...(sized ? { flex: 1, overflow: "auto" } : { overflowX: "auto" }) }}>{children}</div>
      {/* Where a keyboard nudge left the frame, for screen readers; sr-only keeps it out of sight and out of the layout. */}
      <span className="sr-only" role="status" aria-live="polite">
        {announcement}
      </span>
      <ResizeGrip onResizeStart={onResizeStart} onResizeMove={onResizeMove} onResizeEnd={onResizeEnd} />
    </div>
  );
}

/** The drag handle: the title with its error dot on the left, the widget's file name and the three controls on the right. */
function FrameTitleBar({
  entry,
  gesture,
  onFocus,
  onTrash,
  onDragStart,
  onDragMove,
  onDragEnd,
}: {
  entry: WidgetManifestEntry;
  gesture: (g: Gesture) => void;
  onFocus?: (id: string) => void;
  onTrash?: (id: string) => void;
  onDragStart: (e: React.PointerEvent) => void;
  onDragMove: (e: React.PointerEvent) => void;
  onDragEnd: (e: React.PointerEvent) => void;
}) {
  return (
    <div
      onPointerDown={onDragStart}
      onPointerMove={onDragMove}
      onPointerUp={onDragEnd}
      onPointerCancel={onDragEnd}
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 8,
        padding: "8px 12px",
        cursor: "grab",
        background: "var(--loki-panel-header)",
        borderBottom: "1px solid var(--loki-border)",
        touchAction: "none",
      }}
    >
      <span style={{ fontSize: 12, fontWeight: 700, color: "var(--loki-fg)", display: "flex", gap: 8, alignItems: "center" }}>
        {entry.error && <Dot size={7} color="var(--loki-negative)" title={entry.error} />}
        {entry.title}
      </span>
      <span className="loki-frame-controls" style={{ display: "flex", gap: 2, alignItems: "center" }}>
        <span className="loki-meta loki-meta--wrap" style={{ fontFamily: "var(--loki-mono)", marginRight: 6 }}>{entry.name}</span>
        <FrameButton label={`focus ${entry.title}`} title="focus" onClick={() => onFocus?.(entry.id)}>
          {/* target */}
          <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.5">
            <circle cx="8" cy="8" r="4.5" />
            <path d="M8 1v2.5M8 12.5V15M1 8h2.5M12.5 8H15" />
          </svg>
        </FrameButton>
        <FrameButton label={`minimise ${entry.title}`} title="minimise to tray" onClick={() => gesture({ kind: "close", id: entry.id })}>
          <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.5">
            <path d="M3 11.5h10" />
          </svg>
        </FrameButton>
        <FrameButton label={`trash ${entry.title}`} title="delete the widget file" onClick={() => onTrash?.(entry.id)}>
          <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.5">
            <path d="M2.5 4.5h11M6 4.5V3h4v1.5M4 4.5l.7 8.5h6.6l.7-8.5M6.5 7v4M9.5 7v4" />
          </svg>
        </FrameButton>
      </span>
    </div>
  );
}

/** The corner handle that pins a width and height. */
function ResizeGrip({ onResizeStart, onResizeMove, onResizeEnd }: { onResizeStart: (e: React.PointerEvent) => void; onResizeMove: (e: React.PointerEvent) => void; onResizeEnd: (e: React.PointerEvent) => void }) {
  return (
    <div
      className="loki-frame-resize"
      aria-hidden
      title="drag to resize"
      onPointerDown={onResizeStart}
      onPointerMove={onResizeMove}
      onPointerUp={onResizeEnd}
      onPointerCancel={onResizeEnd}
      style={{ position: "absolute", right: 0, bottom: 0, width: 16, height: 16, cursor: "nwse-resize", touchAction: "none", zIndex: 1 }}
    >
      <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="var(--loki-muted)" strokeWidth="1.2" style={{ position: "absolute", right: 1, bottom: 1 }}>
        <path d="M11 15L15 11M7.5 15L15 7.5" />
      </svg>
    </div>
  );
}

function FrameButton({ label, title, onClick, children }: { label: string; title: string; onClick: () => void; children: ReactNode }) {
  return (
    <IconButton size={24} label={label} title={title} danger={label.startsWith("trash")} onPointerDown={(e) => e.stopPropagation()} onClick={onClick}>
      {children}
    </IconButton>
  );
}
