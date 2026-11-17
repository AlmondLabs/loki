import { useLayoutEffect, useRef, type RefObject } from "react";
import { prefersReducedMotion } from "./motion";

export type LeaveFrames = Keyframe[] | null;

const LEAVE_EASE = "cubic-bezier(0.23, 1, 0.32, 1)";

export function useLeave(ref: RefObject<HTMLElement | null>, frames: LeaveFrames | ((el: HTMLElement) => LeaveFrames), ms: number, easing = LEAVE_EASE): void {
  const framesRef = useRef(frames);
  useLayoutEffect(() => {
    framesRef.current = frames;
  });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const opened = performance.now();
    return () => {
      // StrictMode's rehearsal unmount comes within the same frame; a real leave has been on screen longer.
      if (performance.now() - opened < 32 || typeof el.animate !== "function" || prefersReducedMotion()) return;
      const f = framesRef.current;
      const play = typeof f === "function" ? f(el) : f;
      if (!play) return;
      const r = el.getBoundingClientRect();
      const parent = el.parentElement;
      const host = el.closest<HTMLElement>(".loki-phone-shell") ?? document.body;
      if (!r.width || !parent) return;
      const g = el.cloneNode(true) as HTMLElement;
      queueMicrotask(() => {
        if (!parent.isConnected || !host.isConnected) return;
        g.setAttribute("aria-hidden", "true");
        g.inert = true;
        Object.assign(g.style, {
          position: "fixed",
          top: `${r.top}px`,
          left: `${r.left}px`,
          width: `${r.width}px`,
          height: `${r.height}px`,
          margin: "0",
          pointerEvents: "none",
          zIndex: "var(--phone-layer-toast, 300)",
          animation: "none",
          boxSizing: "border-box",
        });
        host.appendChild(g);
        const done = () => g.remove();
        g.animate(play, { duration: ms, easing, fill: "forwards" }).finished.then(done, done);
      });
    };
  }, [ref, ms, easing]);
}
