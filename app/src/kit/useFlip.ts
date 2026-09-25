import { useLayoutEffect, useRef, type RefObject } from "react";
import { spring } from "./spring";
import { prefersReducedMotion } from "./motion";

/**
 * A list whose order changes under you (live data: a desk pinned, an item that now waits on you) glides
 * instead of jumping, by FLIP: after React has put the rows in their new places, each keyed row that moved is
 * drawn back where it was and springs to where it is (transform only, so the compositor does it). A row
 * that is new fades in; a row that went is left behind as a picture that fades while the rows under it
 * slide up into its space.
 *
 * `order` names the arrangement (the keys in order, the folds); the hook measures only when it changes, so a
 * list that re-renders on every streamed update does no layout work until something actually moves.
 * Keyed elements are the container's `[data-flip]` elements and its `li`s with a `[data-launch]` control.
 * The container must be the scroller, positioned (phone.css), so a leaving row's picture scrolls with the rows.
 */

type Spot = { top: number; left: number; width: number; el: HTMLElement };

const keyOf = (el: HTMLElement): string | null => {
  if (el.hasAttribute("data-flip-ghost")) return null;
  if (el.dataset.flip) return el.dataset.flip;
  const launch = el.tagName === "LI" ? el.querySelector<HTMLElement>(":scope > [data-launch]")?.dataset.launch : null;
  return launch ? `row:${launch}` : null;
};

function measure(box: HTMLElement): Map<string, Spot> {
  const out = new Map<string, Spot>();
  const origin = box.getBoundingClientRect();
  for (const el of box.querySelectorAll<HTMLElement>("[data-flip], li")) {
    const key = keyOf(el);
    if (!key || out.has(key)) continue;
    const r = el.getBoundingClientRect();
    out.set(key, { top: r.top - origin.top + box.scrollTop, left: r.left - origin.left, width: r.width, el });
  }
  return out;
}

/** The row that went, as it was, fading where it stood. */
function ghost(box: HTMLElement, spot: Spot): void {
  const g = spot.el.cloneNode(true) as HTMLElement;
  g.setAttribute("data-flip-ghost", "");
  g.setAttribute("aria-hidden", "true");
  g.inert = true;
  Object.assign(g.style, { position: "absolute", top: `${spot.top}px`, left: `${spot.left}px`, width: `${spot.width}px`, margin: "0", pointerEvents: "none", listStyle: "none", zIndex: "0" });
  box.appendChild(g);
  const done = () => g.remove();
  g.animate([{ opacity: 1 }, { opacity: 0, transform: "scale(0.98)" }], { duration: 200, easing: "ease-out", fill: "forwards" }).finished.then(done, done);
}

export function useFlip(ref: RefObject<HTMLElement | null>, order: string | undefined): void {
  const last = useRef<Map<string, Spot> | null>(null);
  useLayoutEffect(() => {
    const box = ref.current;
    // No order (a filter being typed: nothing moves for the keyboard): start afresh next time.
    if (!box || order === undefined) {
      last.current = null;
      return;
    }
    // Out of sight (a tab kept mounted under another): nothing to compare against when it comes back.
    if (box.getClientRects().length === 0) {
      last.current = null;
      return;
    }
    const now = measure(box);
    const before = last.current;
    last.current = now;
    if (!before || typeof box.animate !== "function" || prefersReducedMotion()) return;
    const move = spring("smooth");
    for (const [key, spot] of now) {
      const was = before.get(key);
      if (!was) {
        spot.el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 220, easing: "ease-out" });
        continue;
      }
      const dy = was.top - spot.top;
      if (Math.abs(dy) < 1) continue;
      spot.el.animate([{ transform: `translateY(${dy}px)` }, { transform: "none" }], { duration: move.ms, easing: move.easing });
    }
    for (const [key, spot] of before) if (!now.has(key) && !spot.el.isConnected) ghost(box, spot);
  }, [ref, order]);
}
