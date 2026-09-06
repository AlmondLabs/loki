import { forwardRef, useEffect, useImperativeHandle, useRef, type ReactNode } from "react";
import { TransformWrapper, TransformComponent, type ReactZoomPanPinchRef } from "react-zoom-pan-pinch";

/**
 * Pannable/zoomable surface with Figma's input model:
 *   - two-finger scroll / mouse wheel → pan (no easing, no inertia)
 *   - pinch, or ⌘/Ctrl + scroll        → zoom about the cursor
 *   - drag on empty canvas             → pan
 * The library's own wheel handling is off; we apply transforms directly,
 * coalescing all input that arrives within one animation frame. Widgets carry
 * `.loki-no-pan` so dragging one never pans the canvas.
 * Camera glides (zoomToElement) keep the library's easing.
 */
const MIN_SCALE = 0.1;
const MAX_SCALE = 4;
/** Dot grid: spacing in canvas units; doubled while dots would sit closer than MIN_GRID_PX on screen. */
const GRID_STEP = 24;
const MIN_GRID_PX = 18;
/** Per-event zoom factor clamp: a mouse-wheel notch must not jump more than ~18%. */
const MAX_STEP = 1.18;

export const Viewport = forwardRef<ReactZoomPanPinchRef, { children: ReactNode; onScale?: (scale: number) => void }>(function Viewport(
  { children, onScale },
  ref,
) {
  const inner = useRef<ReactZoomPanPinchRef | null>(null);
  useImperativeHandle(ref, () => inner.current as ReactZoomPanPinchRef, []);
  const host = useRef<HTMLDivElement>(null);
  const grid = useRef<HTMLDivElement>(null);

  /** Keep the dot grid locked to the canvas: same translation, spacing scaled, thinned when zoomed out. */
  const paintGrid = (x: number, y: number, scale: number) => {
    onScale?.(scale);
    const el = grid.current;
    if (!el) return;
    let step = GRID_STEP * scale;
    let level = 0;
    while (step < MIN_GRID_PX && level < 6) {
      step *= 2;
      level++;
    }
    const opacity = Math.min(1, Math.max(0.35, step / 48));
    el.style.backgroundSize = `${step}px ${step}px`;
    el.style.backgroundPosition = `${x}px ${y}px`;
    el.style.opacity = String(opacity);
  };

  useEffect(() => {
    const el = host.current;
    if (!el) return;

    // Pending deltas for the current frame; applied once in rAF.
    let dx = 0;
    let dy = 0;
    let zoom = 1;
    let zx = 0;
    let zy = 0;
    let raf = 0;

    const flush = () => {
      raf = 0;
      const api = inner.current;
      if (!api) return;
      const { scale, positionX, positionY } = api.instance.state;
      let s = scale;
      let x = positionX - dx;
      let y = positionY - dy;
      if (zoom !== 1) {
        s = Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale * zoom));
        const k = s / scale;
        // keep the canvas point under the cursor fixed
        x = zx - (zx - x) * k;
        y = zy - (zy - y) * k;
      }
      dx = dy = 0;
      zoom = 1;
      api.setTransform(x, y, s, 0);
      paintGrid(x, y, s);
    };
    const schedule = () => {
      if (!raf) raf = requestAnimationFrame(flush);
    };

    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? rect.height : 1; // lines / pages → px
      if (e.ctrlKey || e.metaKey) {
        // Pinch (Chrome reports it as ctrl+wheel) or explicit zoom modifier.
        const raw = Math.exp(-e.deltaY * unit * 0.0035);
        zoom *= Math.min(MAX_STEP, Math.max(1 / MAX_STEP, raw));
        zx = e.clientX - rect.left;
        zy = e.clientY - rect.top;
      } else {
        dx += e.deltaX * unit;
        dy += e.deltaY * unit;
      }
      schedule();
    };

    // Safari reports trackpad pinch as gesture events with an absolute scale.
    let gestureScale = 1;
    const onGestureStart = (e: Event) => {
      e.preventDefault();
      gestureScale = 1;
    };
    const onGestureChange = (e: Event) => {
      e.preventDefault();
      const g = e as Event & { scale: number; clientX: number; clientY: number };
      const rect = el.getBoundingClientRect();
      zoom *= g.scale / gestureScale;
      gestureScale = g.scale;
      zx = g.clientX - rect.left;
      zy = g.clientY - rect.top;
      schedule();
    };

    paintGrid(0, 0, 1);
    el.addEventListener("wheel", onWheel, { passive: false });
    el.addEventListener("gesturestart", onGestureStart, { passive: false });
    el.addEventListener("gesturechange", onGestureChange, { passive: false });
    return () => {
      el.removeEventListener("wheel", onWheel);
      el.removeEventListener("gesturestart", onGestureStart);
      el.removeEventListener("gesturechange", onGestureChange);
      if (raf) cancelAnimationFrame(raf);
    };
  }, []);

  return (
    <div ref={host} style={{ position: "relative", width: "100%", height: "100%", overscrollBehavior: "none", touchAction: "none" }}>
      <div
        ref={grid}
        aria-hidden
        style={{
          position: "absolute",
          inset: 0,
          pointerEvents: "none",
          backgroundImage: "radial-gradient(circle, var(--loki-grid) 1.2px, transparent 1.5px)",
          backgroundSize: "24px 24px",
          backgroundPosition: "0px 0px",
        }}
      />
      <TransformWrapper
        onTransform={(_ref, state) => paintGrid(state.positionX, state.positionY, state.scale)}
        ref={inner}
        initialScale={1}
        minScale={MIN_SCALE}
        maxScale={MAX_SCALE}
        limitToBounds={false}
        centerZoomedOut={false}
        doubleClick={{ disabled: true }}
        wheel={{ disabled: true }}
        pinch={{ disabled: true }}
        panning={{ excluded: ["loki-no-pan"], velocityDisabled: true }}
        velocityAnimation={{ disabled: true }}
      >
        <TransformComponent
          wrapperStyle={{ width: "100%", height: "100%" }}
          // No will-change here: a promoted layer keeps its 1x raster and looks pixelated when zoomed.
          contentStyle={{ width: "100%", height: "100%" }}
        >
          {children}
        </TransformComponent>
      </TransformWrapper>
    </div>
  );
});
