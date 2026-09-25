import { useLayoutEffect, useRef, type RefObject } from "react";
import { prefersReducedMotion } from "./motion";

/** How a thing leaves: the frames its picture plays, or null to go at once. */
export type LeaveFrames = Keyframe[] | null;

/**
 * A small thing that leaves the way it came (the Undo button as its seconds run out, the Mac-unreachable
 * banner as the link comes back, a Learn card graded away): when its component unmounts, the element is
 * cloned where it stood and the clone plays `frames`, so the caller never has to keep it mounted for its
 * exit. The clone is fixed over the old spot, inert, inside the phone shell when there is one (the phone's
 * styles are scoped to it), and gone when the animation ends.
 *
 * `frames` may be a function of the element, asked at the moment of leaving (a card flies the way it was
 * graded; null goes at once). A thing that goes with its whole screen (a page closed, a tab left) goes at
 * once too: only a leave that leaves its surroundings in place plays.
 */
export function useLeave(ref: RefObject<HTMLElement | null>, frames: LeaveFrames | ((el: HTMLElement) => LeaveFrames), ms: number, easing = "ease-in"): void {
  // The latest frames, read in the unmount cleanup.
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
      // Read now, while the element is still in place; the clone goes up once React is done removing.
      const r = el.getBoundingClientRect();
      const parent = el.parentElement;
      const host = el.closest<HTMLElement>(".loki-phone-shell") ?? document.body;
      if (!r.width || !parent) return;
      const g = el.cloneNode(true) as HTMLElement;
      queueMicrotask(() => {
        // The screen it was on went too: nothing to leave from.
        if (!parent.isConnected || !host.isConnected) return;
        g.setAttribute("aria-hidden", "true");
        g.inert = true;
        Object.assign(g.style, { position: "fixed", top: `${r.top}px`, left: `${r.left}px`, width: `${r.width}px`, height: `${r.height}px`, margin: "0", pointerEvents: "none", zIndex: "var(--phone-layer-toast, 300)", animation: "none", boxSizing: "border-box" });
        host.appendChild(g);
        const done = () => g.remove();
        g.animate(play, { duration: ms, easing, fill: "forwards" }).finished.then(done, done);
      });
    };
  }, [ref, ms, easing]);
}
