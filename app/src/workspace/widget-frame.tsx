import { useEffect, useRef, type ReactNode } from "react";
import type { Gesture, Size, WidgetLayout, WidgetManifestEntry } from "../../../core/canvas-core.ts";
import { MIN_FRAME, RESIZE_MIN, WIDGET_MAX_WIDTH } from "../../../core/canvas-core.ts";
import { Dot, IconButton } from "../components";
import { useFrameKeyboard } from "./use-frame-keyboard";
import { prefersReducedMotion } from "../kit/motion";
import { CrosshairIcon, MinusIcon, Trash2Icon } from "lucide-react";
import { Glyph } from "../shared/icons";

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
  highlighted?: boolean;
  order?: number;
  gesture: (g: Gesture) => void;
  onMeasure?: (id: string, size: Size) => void;
  onFocus?: (id: string) => void;
  onTrash?: (id: string) => void;
  getScale?: () => number;
  children: ReactNode;
}) {
  const dragRef = useRef<{ startX: number; startY: number; origX: number; origY: number } | null>(null);
  const resizeRef = useRef<{ startX: number; startY: number; origW: number; origH: number } | null>(null);
  const frameRef = useRef<HTMLDivElement>(null);
  const lastSent = useRef(0);
  const pinnedSize = layout.sized === true ? layout.size : undefined;
  const sized = !!pinnedSize;
  const sizedRef = useRef(sized);
  useEffect(() => {
    sizedRef.current = sized;
  });

  const { onKeyDown, announcement } = useFrameKeyboard({ entry, layout, sized, gesture, onFocus, frameRef, lastSentRef: lastSent });

  const glowRef = useRef<HTMLSpanElement>(null);
  const shownHash = useRef(entry.hash);
  useEffect(() => {
    if (shownHash.current === entry.hash) return;
    shownHash.current = entry.hash;
    const el = glowRef.current;
    if (!el || typeof el.animate !== "function" || prefersReducedMotion()) return;
    el.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 1200, easing: "ease-out" });
  }, [entry.hash]);

  useEffect(() => {
    const el = frameRef.current;
    if (!el || !onMeasure || sized) return;
    let last = { w: 0, h: 0 };
    const report = () => {
      if (sizedRef.current || resizeRef.current) return;
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

  const onDragStart = (e: React.PointerEvent) => {
    e.preventDefault();
    try {
      (e.target as Element).setPointerCapture(e.pointerId);
    } catch {}
    dragRef.current = { startX: e.clientX, startY: e.clientY, origX: layout.position.x, origY: layout.position.y };
    if (frameRef.current) frameRef.current.style.willChange = "transform";
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

  const onResizeStart = (e: React.PointerEvent) => {
    e.stopPropagation();
    e.preventDefault();
    try {
      (e.target as Element).setPointerCapture(e.pointerId);
    } catch {}
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
      aria-label={`Widget ${entry.title}`}
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
        ...(pinnedSize ? { width: pinnedSize.w, height: pinnedSize.h } : { width: "fit-content", minWidth: MIN_FRAME.w, maxWidth: WIDGET_MAX_WIDTH }),
        background: "var(--loki-panel)",
        border: `1px solid ${entry.error ? "var(--loki-negative)" : highlighted ? "var(--loki-accent)" : "var(--loki-border)"}`,
        borderRadius: "var(--radius-xl)",
        animationDelay: `${Math.min(order, 12) * 35}ms`,
        boxShadow: "var(--loki-shadow-panel)",
        transition: "border-color 500ms ease-out",
        overflow: "hidden",
        userSelect: "none",
        display: "flex",
        flexDirection: "column",
      }}
    >
      <FrameTitleBar
        entry={entry}
        gesture={gesture}
        onFocus={onFocus}
        onTrash={onTrash}
        onDragStart={onDragStart}
        onDragMove={onDragMove}
        onDragEnd={onDragEnd}
      />
      <div className="loki-frame-body" style={{ padding: 12, minHeight: 0, ...(sized ? { flex: 1, overflow: "auto" } : { overflowX: "auto" }) }}>
        {children}
      </div>
      <span className="sr-only" role="status" aria-live="polite">
        {announcement}
      </span>
      <ResizeGrip onResizeStart={onResizeStart} onResizeMove={onResizeMove} onResizeEnd={onResizeEnd} />
      <span ref={glowRef} aria-hidden className="loki-frame-glow" data-on={highlighted || undefined} />
    </div>
  );
}

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
      className="flex items-center justify-between gap-2"
      style={{
        padding: "8px 12px",
        cursor: "grab",
        background: "var(--loki-panel-header)",
        borderBottom: "1px solid var(--loki-border)",
        touchAction: "none",
      }}
    >
      <span className="flex items-center gap-2" style={{ fontSize: "var(--text-xs)", fontWeight: 700, color: "var(--loki-fg)" }}>
        {entry.error && <Dot size={7} color="var(--loki-negative)" title={entry.error} />}
        {entry.title}
      </span>
      <span className="loki-frame-controls flex items-center gap-0.5">
        <span className="loki-meta loki-meta--wrap loki-mono" style={{ marginRight: 8 }}>
          {entry.name}
        </span>
        <FrameButton label={`Focus ${entry.title}`} title="Focus" onClick={() => onFocus?.(entry.id)}>
          <Glyph icon={CrosshairIcon} size={13} />
        </FrameButton>
        <FrameButton label={`Minimise ${entry.title}`} title="Minimise to tray" onClick={() => gesture({ kind: "close", id: entry.id })}>
          <Glyph icon={MinusIcon} size={13} />
        </FrameButton>
        <FrameButton label={`Trash ${entry.title}`} title="Delete the widget file" onClick={() => onTrash?.(entry.id)}>
          <Glyph icon={Trash2Icon} size={13} />
        </FrameButton>
      </span>
    </div>
  );
}

function ResizeGrip({
  onResizeStart,
  onResizeMove,
  onResizeEnd,
}: {
  onResizeStart: (e: React.PointerEvent) => void;
  onResizeMove: (e: React.PointerEvent) => void;
  onResizeEnd: (e: React.PointerEvent) => void;
}) {
  return (
    <div
      className="loki-frame-resize"
      aria-hidden
      title="Drag to resize"
      onPointerDown={onResizeStart}
      onPointerMove={onResizeMove}
      onPointerUp={onResizeEnd}
      onPointerCancel={onResizeEnd}
      style={{ position: "absolute", right: 0, bottom: 0, width: 16, height: 16, cursor: "nwse-resize", touchAction: "none", zIndex: 1 }}
    >
      <svg
        viewBox="0 0 16 16"
        width="16"
        height="16"
        fill="none"
        stroke="var(--loki-muted)"
        strokeWidth="1.2"
        style={{ position: "absolute", right: 1, bottom: 1 }}
      >
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
