import { useLayoutEffect, useRef, type RefObject } from "react";
import { spring } from "../kit/spring";
import { prefersReducedMotion } from "../kit/motion";
import { onScreenOffset, releaseCommits, releaseVelocity, type Sample } from "../kit/let-go";

const SLOP = 8;
const DISMISS_FRACTION = 0.3;
const FIELDS = "input, textarea, select, [contenteditable='true']";

export const rubberBand = (d: number, limit = 120): number => (d <= 0 ? 0 : limit * (1 - 1 / ((d * 0.55) / limit + 1)));

export const dismisses = (dy: number, height: number, velocity: number): boolean => releaseCommits(dy, velocity, height * DISMISS_FRACTION, SLOP);

function scrolledAbove(target: Element | null, card: HTMLElement): boolean {
  for (let el = target; el && el !== card.parentElement; el = el.parentElement) if (el instanceof HTMLElement && el.scrollTop > 0) return true;
  return false;
}

const RECEDE_DROP = "(var(--phone-safe-top) + 10px)";
const RECEDE_SCALE = 0.06;
const RECEDE_RADIUS = 12;

function leave(veil: HTMLElement, parent: Node, from = 0, velocity = 0): void {
  if (typeof veil.animate !== "function" || prefersReducedMotion()) return;
  const ghost = veil.cloneNode(true) as HTMLElement;
  ghost.setAttribute("data-leaving", "");
  ghost.setAttribute("aria-hidden", "true");
  ghost.inert = true;
  ghost.style.pointerEvents = "none";
  ghost.style.animation = "none";
  const card = ghost.querySelector<HTMLElement>(".loki-sheet-card");
  const live = veil.querySelector(".loki-sheet-card");
  if (!from && live) from = onScreenOffset(live, "y");
  parent.appendChild(ghost);
  const measured = card?.offsetHeight ?? 0;
  const height = measured > 0 ? measured : 400;
  const { easing, ms } = spring("smooth", velocity / Math.max(1, height - from));
  const done = () => ghost.remove();
  if (card) {
    card.style.animation = "none";
    card
      .animate([{ transform: `translateY(${from}px)` }, { transform: "translateY(100%)" }], { duration: ms, easing, fill: "forwards" })
      .finished.then(done, done);
  }
  ghost.animate([{ opacity: Number(getComputedStyle(veil).opacity) || 1 }, { opacity: 0 }], {
    duration: Math.min(ms, 320),
    easing: "ease-out",
    fill: "forwards",
  });
  if (!card) setTimeout(done, ms);
}

export function useSheetMotion(
  veilRef: RefObject<HTMLDivElement | null>,
  cardRef: RefObject<HTMLDivElement | null>,
  onClose: (() => void) | undefined,
  on: boolean,
): void {
  const closeRef = useRef(onClose);
  useLayoutEffect(() => {
    closeRef.current = onClose;
  });
  useLayoutEffect(() => {
    const veil = veilRef.current;
    const card = cardRef.current;
    const parent = veil?.parentElement;
    if (!on || !veil || !card || !parent) return;
    const behind = parent.querySelector<HTMLElement>(":scope > .loki-phone-main");
    const opened = performance.now();
    let gone = false;
    let swallowing: ((c: Event) => void) | null = null;
    let unswallow: ReturnType<typeof setTimeout> | undefined;
    const stopSwallowing = () => {
      clearTimeout(unswallow);
      if (swallowing) window.removeEventListener("click", swallowing, { capture: true });
      swallowing = null;
    };

    let fitFrame = 0;
    const fit = () => card.toggleAttribute("data-fits", card.scrollHeight <= card.clientHeight + 1);
    fit();
    const ro =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(() => {
            if (fitFrame) return;
            fitFrame = requestAnimationFrame(() => {
              fitFrame = 0;
              fit();
            });
          });
    ro?.observe(card);

    let drag: { id: number; x: number; y: number; on: boolean; base: number; samples: Sample[] } | null = null;
    let dy = 0;
    let height = 1;
    const lift = (v: number) => {
      if (!behind) return;
      behind.style.transform = `translateY(calc(${RECEDE_DROP} * ${v})) scale(${1 - RECEDE_SCALE * v})`;
      behind.style.borderRadius = `${RECEDE_RADIUS * v}px`;
    };
    const unlift = () => {
      behind?.style.removeProperty("transform");
      behind?.style.removeProperty("border-radius");
    };
    const place = (d: number) => {
      dy = d;
      card.style.transform = `translateY(${d >= 0 ? d : -rubberBand(-d)}px)`;
      const p = Math.max(0, Math.min(1, d / height));
      veil.style.opacity = String(1 - p * 0.8);
      lift(1 - p);
    };
    const down = (e: PointerEvent) => {
      if (!closeRef.current || (e.pointerType === "mouse" && e.button !== 0) || (e.target as Element).closest(FIELDS)) return;
      drag = { id: e.pointerId, x: e.clientX, y: e.clientY, on: false, base: 0, samples: [{ at: e.clientY, t: e.timeStamp }] };
    };
    const move = (e: PointerEvent) => {
      if (drag?.id !== e.pointerId) return;
      const ddy = e.clientY - drag.y;
      if (!drag.on) {
        if (ddy < SLOP || Math.abs(ddy) < Math.abs(e.clientX - drag.x) || scrolledAbove(e.target as Element, card)) return;
        drag.on = true;
        drag.y = e.clientY;
        height = card.offsetHeight || 1;
        try {
          card.setPointerCapture(e.pointerId);
        } catch {}
        drag.base = onScreenOffset(card, "y");
        card.getAnimations().forEach((a) => a.cancel());
        card.style.transition = "none";
        veil.style.transition = "none";
        parent.setAttribute("data-sheet-drag", "");
      }
      drag.samples.push({ at: e.clientY, t: e.timeStamp });
      if (drag.samples.length > 8) drag.samples.shift();
      place(drag.base + e.clientY - drag.y);
    };
    const up = (e: PointerEvent) => {
      const d = drag;
      if (d?.id !== e.pointerId) return;
      drag = null;
      if (!d.on) return;
      stopSwallowing();
      swallowing = (c: Event) => (c.stopPropagation(), c.preventDefault(), stopSwallowing());
      window.addEventListener("click", swallowing, { capture: true });
      unswallow = setTimeout(stopSwallowing, 0);
      parent.removeAttribute("data-sheet-drag");
      const v = e.type === "pointercancel" ? 0 : releaseVelocity(d.samples, e.timeStamp);
      if (e.type !== "pointercancel" && dismisses(dy, height, v)) {
        gone = true;
        leave(veil, parent, dy, v);
        veil.style.visibility = "hidden";
        lift(0);
        closeRef.current?.();
        return;
      }
      const s = spring("snappy", dy > 1 ? -v / dy : 0);
      card.style.transition = `transform ${s.ms}ms ${s.easing}`;
      veil.style.transition = `opacity ${s.ms}ms ease-out`;
      card.style.transform = "";
      veil.style.opacity = "";
      unlift();
      dy = 0;
    };
    card.addEventListener("pointerdown", down);
    card.addEventListener("pointermove", move);
    card.addEventListener("pointerup", up);
    card.addEventListener("pointercancel", up);
    return () => {
      stopSwallowing();
      if (fitFrame) cancelAnimationFrame(fitFrame);
      ro?.disconnect();
      card.removeEventListener("pointerdown", down);
      card.removeEventListener("pointermove", move);
      card.removeEventListener("pointerup", up);
      card.removeEventListener("pointercancel", up);
      parent.removeAttribute("data-sheet-drag");
      unlift();
      // Outside (React): StrictMode's rehearsal unmount comes within the same frame; a real close has been on screen longer.
      if (!gone && performance.now() - opened > 32 && parent.isConnected) leave(veil, parent, dy);
    };
  }, [on, veilRef, cardRef]);
}
