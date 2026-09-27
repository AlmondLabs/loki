import { useEffect, useLayoutEffect, useRef, type RefObject } from "react";
import { spring } from "../kit/spring";
import { popFromDrag } from "./transitions";

/**
 * Back by a swipe from the screen's left edge, as on iOS: only in the home-screen app, which has no browser to
 * do it. In a Safari tab the browser's own swipe-back owns that edge; both at once would move the page twice.
 * The page follows the finger 1:1; let go past a third of the way, or with a flick, and Back carries on
 * from where the page is at the finger's speed (transitions.ts); short of that it springs home. Only on
 * pages (tabs have nowhere to go back to) and never under a sheet. A drag that starts anywhere but the
 * edge, or goes more up than across, is the page's own.
 */
const EDGE = 24;
const SLOP = 10;
const COMMIT_FRACTION = 0.33;
const FLICK = 500;

export const edgeCommits = (dx: number, width: number, velocity: number): boolean => dx > width * COMMIT_FRACTION || (dx > SLOP * 2 && velocity > FLICK);

/** Opened from the home screen (standalone), not in a browser tab. */
export const standalone = (): boolean =>
  typeof window !== "undefined" && ((typeof matchMedia === "function" && matchMedia("(display-mode: standalone)").matches) || (navigator as Navigator & { standalone?: boolean }).standalone === true);

export function useEdgeSwipe(shellRef: RefObject<HTMLElement | null>, on: boolean, onBack: () => void): void {
  const backRef = useRef(onBack);
  useLayoutEffect(() => {
    backRef.current = onBack;
  });
  useEffect(() => {
    const shell = shellRef.current;
    const main = shell?.querySelector<HTMLElement>(":scope > .loki-phone-main");
    if (!on || !shell || !main || !standalone()) return;
    let g: { id: number; x: number; y: number; on: boolean; samples: { x: number; t: number }[] } | null = null;
    // A gesture's follow-ups (the fallback settle, the transition reset), cleared with the effect.
    const timers = new Set<ReturnType<typeof setTimeout>>();
    const later = (f: () => void, ms: number) => {
      const t = setTimeout(() => (timers.delete(t), f()), ms);
      timers.add(t);
    };
    const settle = () => {
      shell.removeAttribute("data-edge-drag");
      main.style.transform = "";
    };
    const down = (e: PointerEvent) => {
      if (e.pointerType === "mouse" || e.clientX > EDGE || shell.querySelector(":scope > .loki-veil:not([data-leaving])")) return;
      g = { id: e.pointerId, x: e.clientX, y: e.clientY, on: false, samples: [{ x: e.clientX, t: e.timeStamp }] };
    };
    const move = (e: PointerEvent) => {
      if (!g || g.id !== e.pointerId) return;
      const dx = e.clientX - g.x;
      const dy = e.clientY - g.y;
      if (!g.on) {
        if (Math.abs(dy) > SLOP && Math.abs(dy) > dx) g = null; // a scroll, not a Back
        if (!g || dx < SLOP) return;
        g.on = true;
        g.x = e.clientX; // no jump by the slop
        try {
          shell.setPointerCapture(e.pointerId);
        } catch {
          /* a pointer that already left */
        }
        main.style.transition = "none";
        shell.setAttribute("data-edge-drag", "");
      }
      g.samples.push({ x: e.clientX, t: e.timeStamp });
      if (g.samples.length > 8) g.samples.shift();
      main.style.transform = `translateX(${Math.max(0, e.clientX - g.x)}px)`;
    };
    const up = (e: PointerEvent) => {
      const d = g;
      if (!d || d.id !== e.pointerId) return;
      g = null;
      if (!d.on) return;
      const dx = Math.max(0, e.clientX - d.x);
      const first = d.samples[0];
      const last = d.samples[d.samples.length - 1];
      const v = e.type === "pointercancel" || last.t === first.t ? 0 : ((last.x - first.x) / (last.t - first.t)) * 1000;
      if (e.type !== "pointercancel" && edgeCommits(dx, shell.clientWidth || 390, v)) {
        popFromDrag(dx, v, () => {
          main.style.transition = "none";
          settle();
          requestAnimationFrame(() => (main.style.transition = ""));
        });
        backRef.current();
        // If Back never lands (nothing to go back to), the page must not stay across.
        later(() => {
          if (shell.hasAttribute("data-edge-drag")) {
            main.style.transition = "";
            settle();
          }
        }, 800);
        return;
      }
      const s = spring("snappy", dx > 1 ? -v / dx : 0);
      main.style.transition = `transform ${s.ms}ms ${s.easing}`;
      settle();
      later(() => (main.style.transition = ""), s.ms);
    };
    shell.addEventListener("pointerdown", down);
    shell.addEventListener("pointermove", move);
    shell.addEventListener("pointerup", up);
    shell.addEventListener("pointercancel", up);
    return () => {
      shell.removeEventListener("pointerdown", down);
      shell.removeEventListener("pointermove", move);
      shell.removeEventListener("pointerup", up);
      shell.removeEventListener("pointercancel", up);
      timers.forEach(clearTimeout);
      main.style.transition = "";
      settle();
    };
  }, [on, shellRef]);
}
