import { useLayoutEffect, type RefObject } from "react";
import { prefersReducedMotion } from "./motion";

/**
 * A small thing that leaves the way it came (the Undo button as its seconds run out): when its component
 * unmounts, the element is cloned where it stood and the clone plays `frames`, so the caller never has to keep
 * it mounted for its exit. The clone is fixed over the old spot, inert, inside the phone shell when there is one
 * (the phone's styles are scoped to it), and gone when the animation ends.
 */
export function useLeave(ref: RefObject<HTMLElement | null>, frames: Keyframe[], ms: number, easing = "ease-in"): void {
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const opened = performance.now();
    return () => {
      // StrictMode's rehearsal unmount comes within the same frame; a real leave has been on screen longer.
      if (performance.now() - opened < 32 || typeof el.animate !== "function" || prefersReducedMotion()) return;
      const r = el.getBoundingClientRect();
      const host = el.closest<HTMLElement>(".loki-phone-shell") ?? document.body;
      if (!r.width || !host.isConnected) return;
      const g = el.cloneNode(true) as HTMLElement;
      g.setAttribute("aria-hidden", "true");
      g.inert = true;
      Object.assign(g.style, { position: "fixed", top: `${r.top}px`, left: `${r.left}px`, width: `${r.width}px`, height: `${r.height}px`, margin: "0", pointerEvents: "none", zIndex: "var(--phone-layer-toast, 300)", animation: "none" });
      host.appendChild(g);
      const done = () => g.remove();
      g.animate(frames, { duration: ms, easing, fill: "forwards" }).finished.then(done, done);
    };
    // The frames are the caller's constant; the element is the mount's.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ref]);
}
