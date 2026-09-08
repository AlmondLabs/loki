import { useEffect, useRef, useState, type ReactNode } from "react";
import type { Gesture, Position, Size, WidgetLayout, WidgetManifestEntry } from "../../../packages/core/src/desk-core.ts";
import { MIN_FRAME, RESIZE_MIN, WIDGET_MAX_WIDTH } from "../../../packages/core/src/desk-core.ts";
import { Dot, IconButton } from "../ui";

/** Keyboard nudge in canvas px: arrows move or (with Alt) resize by a step; Shift takes the long step. */
const NUDGE_STEP = 8;
const NUDGE_STEP_LONG = 32;
/** Keyboard nudges commit at the drag's cadence: at most one gesture per this many ms, with a trailing commit. */
const NUDGE_COMMIT_MS = 50;
/** The live region speaks once a burst of nudges has settled. */
const ANNOUNCE_MS = 300;

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

  // Keyboard nudges: the next position/size waiting to be committed, and the timer that commits them.
  // Committing through `gesture` (the drag's release path) keeps undo honest: the mod collapses commits
  // that land within its burst window into one step, so ⌘Z undoes a press, or a held key, at a time.
  const nudgeRef = useRef<{ position: Position | null; size: Size | null; timer: ReturnType<typeof setTimeout> | null }>({ position: null, size: null, timer: null });
  const [announcement, setAnnouncement] = useState("");
  const announceRef = useRef<{ text: string; timer: ReturnType<typeof setTimeout> | null }>({ text: "", timer: null });
  useEffect(
    () => () => {
      if (nudgeRef.current.timer) clearTimeout(nudgeRef.current.timer);
      if (announceRef.current.timer) clearTimeout(announceRef.current.timer);
    },
    [],
  );

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

  const commitNudge = () => {
    const n = nudgeRef.current;
    n.timer = null;
    lastSent.current = performance.now();
    if (n.position) {
      const position = n.position;
      n.position = null;
      gesture({ kind: "move", id: entry.id, position });
    }
    if (n.size) {
      const size = n.size;
      n.size = null;
      gesture({ kind: "resize", id: entry.id, size });
    }
  };
  const scheduleNudge = () => {
    const n = nudgeRef.current;
    if (n.timer) return; // the pending commit picks up the latest values
    n.timer = setTimeout(commitNudge, Math.max(0, NUDGE_COMMIT_MS - (performance.now() - lastSent.current)));
  };
  const announce = (text: string) => {
    const a = announceRef.current;
    a.text = text;
    if (a.timer) clearTimeout(a.timer);
    a.timer = setTimeout(() => {
      a.timer = null;
      setAnnouncement(a.text);
    }, ANNOUNCE_MS);
  };

  // Keys on the frame or its title bar. The body belongs to the widget (an agent's own inputs), so
  // nothing here fires for a target inside it; Enter and Escape act only on the frame itself, so the
  // control buttons keep their native Enter.
  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement;
    const onFrame = target === e.currentTarget;
    if (!onFrame && target.closest(".loki-frame-body")) return;
    if (e.key === "Enter") {
      if (!onFrame) return;
      e.preventDefault();
      e.stopPropagation();
      onFocus?.(entry.id);
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      if (onFrame) frameRef.current?.blur();
      else frameRef.current?.focus(); // step out of a control back to the frame
      return;
    }
    if (e.metaKey || e.ctrlKey) return; // ⌘← / ⌘→ place the chat; leave chords to the keymap
    const dx = e.key === "ArrowLeft" ? -1 : e.key === "ArrowRight" ? 1 : 0;
    const dy = e.key === "ArrowUp" ? -1 : e.key === "ArrowDown" ? 1 : 0;
    if (!dx && !dy) return;
    e.preventDefault();
    e.stopPropagation();
    const step = e.shiftKey ? NUDGE_STEP_LONG : NUDGE_STEP;
    const n = nudgeRef.current;
    if (e.altKey) {
      const el = frameRef.current;
      const base = n.size ?? (sized && layout.size ? layout.size : { w: el?.offsetWidth ?? RESIZE_MIN.w, h: el?.offsetHeight ?? RESIZE_MIN.h });
      const size = { w: Math.round(Math.max(RESIZE_MIN.w, base.w + dx * step)), h: Math.round(Math.max(RESIZE_MIN.h, base.h + dy * step)) };
      n.size = size;
      announce(`resized to ${size.w}×${size.h}`);
    } else {
      const base = n.position ?? layout.position;
      const position = { x: Math.round(base.x + dx * step), y: Math.round(base.y + dy * step) };
      n.position = position;
      announce(`moved to ${position.x}, ${position.y}`);
    }
    scheduleNudge();
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
          background: "var(--loki-panel-header)",
          borderBottom: "1px solid var(--loki-border)",
          touchAction: "none",
        }}
      >
        <span style={{ fontFamily: "var(--loki-label)", fontSize: 10.5, fontWeight: 500, letterSpacing: "0.14em", textTransform: "uppercase", color: "var(--loki-fg)", display: "flex", gap: 8, alignItems: "center" }}>
          {entry.error && <Dot size={7} color="var(--loki-negative)" title={entry.error} />}
          {entry.title}
        </span>
        <span className="loki-frame-controls" style={{ display: "flex", gap: 2, alignItems: "center" }}>
          <span style={{ fontSize: 10.5, color: "var(--loki-muted)", fontFamily: "var(--loki-mono)", marginRight: 6 }}>{entry.name}</span>
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
      <div className="loki-frame-body" style={{ padding: 12, minHeight: 0, ...(sized ? { flex: 1, overflow: "auto" } : { overflowX: "auto" }) }}>{children}</div>
      {/* Where a keyboard nudge left the frame, for screen readers; sr-only keeps it out of sight and out of the layout. */}
      <span className="sr-only" role="status" aria-live="polite">
        {announcement}
      </span>
      <div
        className="loki-frame-resize"
        aria-hidden
        title="drag to resize"
        onPointerDown={(e) => {
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
        }}
        onPointerMove={onResizeMove}
        onPointerUp={onResizeEnd}
        onPointerCancel={onResizeEnd}
        style={{ position: "absolute", right: 0, bottom: 0, width: 16, height: 16, cursor: "nwse-resize", touchAction: "none", zIndex: 1 }}
      >
        <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="var(--loki-muted)" strokeWidth="1.2" style={{ position: "absolute", right: 1, bottom: 1 }}>
          <path d="M11 15L15 11M7.5 15L15 7.5" />
        </svg>
      </div>
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
