import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, type ReactNode } from "react";
import { TransformWrapper, TransformComponent, type ReactZoomPanPinchRef } from "react-zoom-pan-pinch";
import { stopGlide } from "./camera-glide";

const MIN_SCALE = 0.1;
const MAX_SCALE = 4;
const GRID_STEP = 24;
const MIN_GRID_PX = 18;
const MAX_STEP = 1.18;

export const Viewport = forwardRef<ReactZoomPanPinchRef | null, { children: ReactNode; onScale?: (scale: number) => void }>(function Viewport(
  { children, onScale },
  ref,
) {
  const inner = useRef<ReactZoomPanPinchRef | null>(null);
  useImperativeHandle<ReactZoomPanPinchRef | null, ReactZoomPanPinchRef | null>(ref, () => inner.current, []);
  const host = useRef<HTMLDivElement>(null);
  const grid = useRef<HTMLDivElement>(null);

  const onScaleRef = useRef(onScale);
  useEffect(() => {
    onScaleRef.current = onScale;
  });

  const paintGrid = useCallback((x: number, y: number, scale: number) => {
    onScaleRef.current?.(scale);
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
  }, []);

  useEffect(() => {
    const el = host.current;
    if (!el) return;

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
        x = zx - (zx - x) * k;
        y = zy - (zy - y) * k;
      }
      dx = dy = 0;
      zoom = 1;
      void api.setTransform(x, y, s, 0);
      paintGrid(x, y, s);
    };
    const schedule = () => {
      if (!raf) raf = requestAnimationFrame(flush);
    };

    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      stopGlide();
      const rect = el.getBoundingClientRect();
      const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? rect.height : 1;
      if (e.ctrlKey || e.metaKey) {
        // Outside (Chrome): a trackpad pinch arrives as a wheel with ctrl held.
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

    // Outside (WebKit): a trackpad pinch arrives as gesture events with an absolute scale.
    let gestureScale = 1;
    const onGestureStart = (e: Event) => {
      e.preventDefault();
      gestureScale = 1;
    };
    const onGestureChange = (e: Event) => {
      e.preventDefault();
      stopGlide();
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
  }, [paintGrid]);

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
        onPanningStart={stopGlide}
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
          // Outside (Chrome): a layer promoted by will-change keeps its 1x raster and looks pixelated when zoomed.
          contentStyle={{ width: "100%", height: "100%" }}
        >
          {children}
        </TransformComponent>
      </TransformWrapper>
    </div>
  );
});
