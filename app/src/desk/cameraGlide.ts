import type { ReactZoomPanPinchRef } from "react-zoom-pan-pinch";
import { prefersReducedMotion } from "../kit/motion";
import { settleTime, springAt, SPRINGS } from "../kit/spring";

/**
 * The camera's glide to a widget (a widget landing, loki_camera, focus, fit all) on the smooth spring, as the
 * rest of loki moves, instead of the pan-zoom library's fixed ease-out. The library draws the canvas one
 * transform at a time, so the spring is stepped once a frame here and each step handed to it at once.
 *
 * One glide at a time: a new one starts from wherever the last has got to, and a wheel, a pinch or a drag
 * stops it where it is (stopGlide), so the camera is never fought for. Reduced motion jumps.
 */

let frame = 0;

/** Stop the glide under way, leaving the camera where it has got to. */
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
    api.setTransform(x0 + (x - x0) * p, y0 + (y - y0) * p, s0 + (scale - s0) * p, 0);
    frame = t >= total ? 0 : requestAnimationFrame(step);
  };
  frame = requestAnimationFrame(step);
}
