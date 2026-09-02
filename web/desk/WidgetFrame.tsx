import { useRef, type ReactNode } from "react";
import type { Patch, WidgetState } from "./useDesk";

/**
 * Standard widget chrome: drag by the title bar, close button, focus-to-front.
 * Interactions inside the body never move the widget (drag is handle-only),
 * and pointer events stop here so the surface never mistakes them for panning.
 */
export function WidgetFrame({
  widget,
  patch,
  getScale,
  children,
}: {
  widget: WidgetState;
  patch: (p: Patch) => void;
  /** Current viewport zoom — screen-pixel drags divide by it (U7). */
  getScale?: () => number;
  children: ReactNode;
}) {
  const dragRef = useRef<{ startX: number; startY: number; origX: number; origY: number } | null>(
    null,
  );
  const lastSent = useRef(0);

  const onHandlePointerDown = (e: React.PointerEvent) => {
    e.preventDefault();
    (e.target as Element).setPointerCapture(e.pointerId);
    dragRef.current = {
      startX: e.clientX,
      startY: e.clientY,
      origX: widget.position.x,
      origY: widget.position.y,
    };
    patch({ op: "focus", id: widget.id });
  };

  const dragPosition = (d: NonNullable<typeof dragRef.current>, e: React.PointerEvent) => {
    const scale = getScale?.() ?? 1;
    return {
      x: d.origX + (e.clientX - d.startX) / scale,
      y: d.origY + (e.clientY - d.startY) / scale,
    };
  };

  const onHandlePointerMove = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    const now = performance.now();
    if (now - lastSent.current > 33) {
      lastSent.current = now;
      patch({ op: "move", id: widget.id, position: dragPosition(d, e) });
    }
  };

  const onHandlePointerUp = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    dragRef.current = null;
    patch({ op: "move", id: widget.id, position: dragPosition(d, e) });
  };

  return (
    <div
      id={`widget-${widget.id}`}
      className="loci-no-pan"
      onPointerDown={(e) => {
        e.stopPropagation();
        patch({ op: "focus", id: widget.id });
      }}
      style={{
        position: "absolute",
        left: widget.position.x,
        top: widget.position.y,
        zIndex: widget.z,
        width: widget.size?.w ?? 280,
        background: "var(--loci-panel, #1a1a20)",
        border: "1px solid var(--loci-border, #2c2c34)",
        borderRadius: 10,
        boxShadow: "0 8px 28px rgba(0,0,0,0.45)",
        overflow: "hidden",
        userSelect: "none",
      }}
    >
      <div
        onPointerDown={onHandlePointerDown}
        onPointerMove={onHandlePointerMove}
        onPointerUp={onHandlePointerUp}
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "8px 12px",
          cursor: "grab",
          background: "var(--loci-panel-header, #202027)",
          borderBottom: "1px solid var(--loci-border, #2c2c34)",
          touchAction: "none",
        }}
      >
        <span style={{ fontSize: 12, letterSpacing: "0.06em", color: "var(--loci-fg, #e8e8ec)" }}>
          {widget.title}
        </span>
        <button
          onPointerDown={(e) => e.stopPropagation()}
          onClick={() => patch({ op: "close", id: widget.id })}
          aria-label={`close ${widget.title}`}
          style={{
            border: "none",
            background: "transparent",
            color: "var(--loci-muted, #8b8b94)",
            cursor: "pointer",
            fontSize: 14,
            lineHeight: 1,
            padding: 2,
          }}
        >
          ×
        </button>
      </div>
      <div style={{ padding: 12 }}>{children}</div>
    </div>
  );
}
