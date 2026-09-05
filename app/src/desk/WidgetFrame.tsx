import { useEffect, useRef, type ReactNode } from "react";
import type { Gesture, Size, WidgetLayout, WidgetManifestEntry } from "../../../shared/desk-core.ts";

/**
 * Standard widget chrome: drag by the title bar, close, focus-to-front, an
 * error dot when the file is broken. Pointer events stop here so the surface
 * never mistakes them for panning.
 */
export function WidgetFrame({
  entry,
  layout,
  highlighted = false,
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
  const frameRef = useRef<HTMLDivElement>(null);
  const lastSent = useRef(0);

  // Report the rendered size (canvas units: offsetWidth/Height ignore the viewport transform).
  useEffect(() => {
    const el = frameRef.current;
    if (!el || !onMeasure) return;
    let last = { w: 0, h: 0 };
    const report = () => {
      const w = el.offsetWidth;
      const h = el.offsetHeight;
      if (Math.abs(w - last.w) < 2 && Math.abs(h - last.h) < 2) return;
      last = { w, h };
      onMeasure(entry.id, { w, h });
    };
    report();
    const ro = new ResizeObserver(report);
    ro.observe(el);
    return () => ro.disconnect();
  }, [entry.id, onMeasure]);

  const dragPosition = (d: NonNullable<typeof dragRef.current>, e: React.PointerEvent) => {
    const scale = getScale?.() ?? 1;
    return { x: d.origX + (e.clientX - d.startX) / scale, y: d.origY + (e.clientY - d.startY) / scale };
  };

  // While dragging, move the frame directly (every pointer event, no React re-render) and
  // send throttled moves for other tabs; the final position is committed on release.
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

  return (
    <div
      ref={frameRef}
      id={`widget-${entry.id.replace("/", "--")}`}
      className="loci-no-pan"
      onPointerDown={(e) => {
        e.stopPropagation();
        gesture({ kind: "focus", id: entry.id });
      }}
      style={{
        position: "absolute",
        left: layout.position.x,
        top: layout.position.y,
        zIndex: layout.z,
        width: layout.size?.w ?? 280,
        background: "var(--loci-panel)",
        border: `1px solid ${entry.error ? "var(--loci-negative)" : highlighted ? "var(--loci-accent)" : "var(--loci-border)"}`,
        borderRadius: "var(--loci-radius)",
        boxShadow: highlighted
          ? "0 0 0 3px var(--loci-accent-soft), 0 0 40px 4px rgba(91,124,250,0.35), 0 8px 28px rgba(0,0,0,0.45)"
          : "0 8px 28px rgba(0,0,0,0.45)",
        transition: "box-shadow 500ms ease-out, border-color 500ms ease-out",
        overflow: "hidden",
        userSelect: "none",
      }}
    >
      <div
        onPointerDown={(e) => {
          e.preventDefault();
          try {
            (e.target as Element).setPointerCapture(e.pointerId);
          } catch {
            // synthetic or already-released pointer; dragging still works within the element
          }
          dragRef.current = { startX: e.clientX, startY: e.clientY, origX: layout.position.x, origY: layout.position.y };
          if (frameRef.current) frameRef.current.style.willChange = "transform"; // only while dragging
        }}
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
          background: "var(--loci-panel-header)",
          borderBottom: "1px solid var(--loci-border)",
          touchAction: "none",
        }}
      >
        <span style={{ fontFamily: "var(--loci-label)", fontSize: 11, fontWeight: 500, letterSpacing: "0.12em", textTransform: "uppercase", color: "var(--loci-fg)", display: "flex", gap: 8, alignItems: "center" }}>
          {entry.error && (
            <span title={entry.error} style={{ width: 7, height: 7, borderRadius: 4, background: "var(--loci-negative)" }} />
          )}
          {entry.title}
        </span>
        <span style={{ display: "flex", gap: 2, alignItems: "center" }}>
          <span style={{ fontSize: 10, color: "var(--loci-muted)", fontFamily: "var(--loci-mono)", marginRight: 6 }}>{entry.name}</span>
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
          <FrameButton label={`trash ${entry.title}`} title="delete the widget file" danger onClick={() => onTrash?.(entry.id)}>
            <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.5">
              <path d="M2.5 4.5h11M6 4.5V3h4v1.5M4 4.5l.7 8.5h6.6l.7-8.5M6.5 7v4M9.5 7v4" />
            </svg>
          </FrameButton>
        </span>
      </div>
      <div style={{ padding: 12 }}>{children}</div>
    </div>
  );
}

function FrameButton({
  label,
  title,
  danger = false,
  onClick,
  children,
}: {
  label: string;
  title: string;
  danger?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      onPointerDown={(e) => e.stopPropagation()}
      onClick={onClick}
      aria-label={label}
      title={title}
      style={{
        display: "grid",
        placeItems: "center",
        width: 22,
        height: 22,
        border: "none",
        borderRadius: 6,
        background: "transparent",
        color: "var(--loci-muted)",
        cursor: "pointer",
        padding: 0,
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.color = danger ? "var(--loci-negative)" : "var(--loci-fg)";
        e.currentTarget.style.background = "rgba(255,255,255,0.06)";
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.color = "var(--loci-muted)";
        e.currentTarget.style.background = "transparent";
      }}
    >
      {children}
    </button>
  );
}
