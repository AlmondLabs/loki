import { useLayoutEffect, useRef, type RefObject } from "react";
import { spring } from "../kit/spring";
import { prefersReducedMotion } from "../kit/motion";

/**
 * A bottom sheet that moves the way an iOS sheet does (the phone's; placement="bottom"):
 *   - it rises on the smooth spring (CSS, phone.css), and the screen behind recedes while it is up;
 *   - it follows a finger down, 1:1, and stretches a little if pulled up past its top;
 *   - let go far enough or fast enough and it leaves at the finger's speed; otherwise it springs back;
 *   - however it closes (the veil, Escape, a row that closes it, its caller unmounting it) it leaves the way
 *     it came: the node is cloned as it was and the clone slides away, so no caller has to wait for it.
 * The drag starts anywhere in the sheet but the fields, and only downward; a list that scrolls keeps its
 * own vertical pans (touch-action, phone.css). A drag never counts as a tap on the row it started on.
 *
 * The veil's parent is the phone shell (Sheet portals there); the drag writes --sheet-lift on it, 1 while
 * the sheet is up and falling toward 0 as it is pulled down, which the receded screen follows.
 */

const SLOP = 8;
/** Pulled past this share of its height, or flicked faster than FLICK px/s, the sheet goes. */
const DISMISS_FRACTION = 0.3;
const FLICK = 700;
const FIELDS = "input, textarea, select, [contenteditable='true']";

/** Past its resting place a pull meets resistance, as iOS rubber-bands: a third of the distance, easing off. */
export const rubberBand = (d: number, limit = 120): number => (d <= 0 ? 0 : limit * (1 - 1 / ((d * 0.55) / limit + 1)));

/** Leave now: whether a released drag closes the sheet. */
export const dismisses = (dy: number, height: number, velocity: number): boolean => dy > height * DISMISS_FRACTION || (dy > SLOP && velocity > FLICK);

/** Something inside that scrolls and is not at its top: a downward pull is that list's, not the sheet's. */
function scrolledAbove(target: Element | null, card: HTMLElement): boolean {
  for (let el = target; el && el !== card.parentElement; el = el.parentElement) if (el instanceof HTMLElement && el.scrollTop > 0) return true;
  return false;
}

/** The clone that plays the exit, marked so the receded screen comes back while it goes. */
function leave(veil: HTMLElement, parent: Node, from = 0, velocity = 0): void {
  if (typeof veil.animate !== "function" || prefersReducedMotion()) return;
  const ghost = veil.cloneNode(true) as HTMLElement;
  ghost.setAttribute("data-leaving", "");
  ghost.setAttribute("aria-hidden", "true");
  ghost.inert = true;
  ghost.style.pointerEvents = "none";
  ghost.style.animation = "none";
  const card = ghost.querySelector<HTMLElement>(".loki-sheet-card");
  parent.appendChild(ghost);
  const height = card?.offsetHeight || 400;
  const { easing, ms } = spring("smooth", velocity / Math.max(1, height - from));
  const done = () => ghost.remove();
  if (card) {
    card.style.animation = "none";
    card.animate([{ transform: `translateY(${from}px)` }, { transform: "translateY(100%)" }], { duration: ms, easing, fill: "forwards" }).finished.then(done, done);
  }
  ghost.animate([{ opacity: Number(getComputedStyle(veil).opacity) || 1 }, { opacity: 0 }], { duration: Math.min(ms, 320), easing: "ease-out", fill: "forwards" });
  if (!card) setTimeout(done, ms);
}

export function useSheetMotion(veilRef: RefObject<HTMLDivElement | null>, cardRef: RefObject<HTMLDivElement | null>, onClose: (() => void) | undefined, on: boolean): void {
  // Callers pass a fresh closure each render; the sheet's life is its mount, not that closure's.
  const closeRef = useRef(onClose);
  useLayoutEffect(() => {
    closeRef.current = onClose;
  });
  useLayoutEffect(() => {
    const veil = veilRef.current;
    const card = cardRef.current;
    const parent = veil?.parentElement;
    if (!on || !veil || !card || !parent) return;
    const opened = performance.now();
    let gone = false; // a drag already played the exit

    // Whether the whole sheet can take a vertical drag: yes while it fits, else only its grip and head.
    const fit = () => card.toggleAttribute("data-fits", card.scrollHeight <= card.clientHeight + 1);
    fit();
    const ro = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(fit);
    ro?.observe(card);

    let drag: { id: number; x: number; y: number; on: boolean; samples: { y: number; t: number }[] } | null = null;
    let dy = 0;
    const lift = (v: number) => parent.style.setProperty("--sheet-lift", String(v));
    const place = (d: number) => {
      dy = d;
      card.style.transform = `translateY(${d >= 0 ? d : -rubberBand(-d)}px)`;
      const h = card.offsetHeight || 1;
      const p = Math.max(0, Math.min(1, d / h));
      veil.style.opacity = String(1 - p * 0.8);
      lift(1 - p);
    };
    const down = (e: PointerEvent) => {
      if (!closeRef.current || (e.pointerType === "mouse" && e.button !== 0) || (e.target as Element).closest(FIELDS)) return;
      drag = { id: e.pointerId, x: e.clientX, y: e.clientY, on: false, samples: [{ y: e.clientY, t: e.timeStamp }] };
    };
    const move = (e: PointerEvent) => {
      if (!drag || drag.id !== e.pointerId) return;
      const ddy = e.clientY - drag.y;
      if (!drag.on) {
        if (ddy < SLOP || Math.abs(ddy) < Math.abs(e.clientX - drag.x) || scrolledAbove(e.target as Element, card)) return;
        drag.on = true;
        drag.y = e.clientY; // no jump by the slop
        try {
          card.setPointerCapture(e.pointerId);
        } catch {
          /* a pointer that already left */
        }
        card.getAnimations().forEach((a) => a.cancel()); // caught mid-rise: from here the finger has it
        card.style.transition = "none";
        veil.style.transition = "none";
        parent.setAttribute("data-sheet-drag", "");
      }
      drag.samples.push({ y: e.clientY, t: e.timeStamp });
      if (drag.samples.length > 8) drag.samples.shift();
      place(e.clientY - drag.y);
    };
    const up = (e: PointerEvent) => {
      const d = drag;
      if (!d || d.id !== e.pointerId) return;
      drag = null;
      if (!d.on) return;
      // The tap this drag started on is not a tap.
      const swallow = (c: Event) => (c.stopPropagation(), c.preventDefault());
      window.addEventListener("click", swallow, { capture: true, once: true });
      setTimeout(() => window.removeEventListener("click", swallow, { capture: true }), 0);
      parent.removeAttribute("data-sheet-drag");
      const first = d.samples[0];
      const last = d.samples[d.samples.length - 1];
      const v = e.type === "pointercancel" || last.t === first.t ? 0 : ((last.y - first.y) / (last.t - first.t)) * 1000;
      const h = card.offsetHeight || 1;
      if (e.type !== "pointercancel" && dismisses(dy, h, v)) {
        gone = true;
        leave(veil, parent, dy, v);
        veil.style.visibility = "hidden";
        lift(0);
        closeRef.current?.();
        return;
      }
      // Back up, carrying the finger's speed (toward the top is toward the target).
      const s = spring("snappy", dy > 1 ? -v / dy : 0);
      card.style.transition = `transform ${s.ms}ms ${s.easing}`;
      veil.style.transition = `opacity ${s.ms}ms ease-out`;
      card.style.transform = "";
      veil.style.opacity = "";
      parent.style.removeProperty("--sheet-lift");
      dy = 0;
    };
    card.addEventListener("pointerdown", down);
    card.addEventListener("pointermove", move);
    card.addEventListener("pointerup", up);
    card.addEventListener("pointercancel", up);
    return () => {
      ro?.disconnect();
      card.removeEventListener("pointerdown", down);
      card.removeEventListener("pointermove", move);
      card.removeEventListener("pointerup", up);
      card.removeEventListener("pointercancel", up);
      parent.removeAttribute("data-sheet-drag");
      parent.style.removeProperty("--sheet-lift");
      // StrictMode's rehearsal unmount comes within the same frame; a real close has been on screen longer.
      if (!gone && performance.now() - opened > 32 && parent.isConnected) leave(veil, parent, dy);
    };
  }, [on, veilRef, cardRef]);
}
