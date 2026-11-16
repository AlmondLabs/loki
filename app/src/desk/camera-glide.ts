import type { ReactZoomPanPinchRef } from "react-zoom-pan-pinch";
import { prefersReducedMotion } from "../kit/motion";
import { settleTime, springAt, SPRINGS } from "../kit/spring";

let frame = 0;

export function stopGlide(): void {
  if (frame) cancelAnimationFrame(frame);
  frame = 0;
}

export function glideTo(api: ReactZoomPanPinchRef, x: number, y: number, scale: number): void {
  stopGlide();
  const from = api.instance.state;
  if (prefersReducedMotion() || typeof requestAnimationFrame !== "function") return void api.setTransform(x, y, scale, 0);
  const spring = SPRINGS.smooth;
  const total = settleTime(spring) * 1000;
  const x0 = from.positionX;
  const y0 = from.positionY;
  const s0 = from.scale;
  const start = performance.now();
  const step = (now: number) => {
    const t = Math.min(total, now - start);
    const p = t >= total ? 1 : springAt(spring, t / 1000);
    void api.setTransform(x0 + (x - x0) * p, y0 + (y - y0) * p, s0 + (scale - s0) * p, 0);
    frame = t >= total ? 0 : requestAnimationFrame(step);
  };
  frame = requestAnimationFrame(step);
}
