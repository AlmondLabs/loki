import { flushSync } from "react-dom";
import { spring } from "../kit/spring";
import { lastInput, prefersReducedMotion } from "../kit/motion";
import { formatRoute, type Arrival, type Route } from "./router";

export type NavMotion = "push" | "pop" | "zoom" | "fade";

let zoomed: string | null = null;
let zoomNext = false;
export function openFromCard(): void {
  zoomNext = true;
}

/**
 * A Back the app itself asked for (its back chevron, its edge swipe). Any other pop is the browser's own:
 * Safari's swipe-back has already slid the page away with its own picture, and sliding it again would play
 * Back twice, so that one lands without a transition.
 */
let ownPop = false;
export function expectPop(): void {
  ownPop = true;
}

let dragged: { dx: number; velocity: number; reset: () => void } | null = null;
export function popFromDrag(dx: number, velocity: number, reset: () => void): void {
  dragged = { dx, velocity, reset };
}

const isPage = (r: Route) => r.kind !== "tab";

export function motionFor(from: Route, to: Route, arrival: Arrival, zoomedHash: string | null = zoomed): Exclude<NavMotion, "fade"> | null {
  if (arrival === "load" || formatRoute(from) === formatRoute(to)) return null;
  if (!isPage(from) && !isPage(to)) return null;
  if (arrival === "pop") {
    if (!isPage(from)) return null;
    if (zoomedHash === formatRoute(from) && to.kind === "tab" && to.tab === "inbox") return "zoom";
    return "pop";
  }
  if (arrival === "push") return isPage(to) ? "push" : null;
  return null;
}

let seq = 0;

interface ViewTransition {
  finished: Promise<void>;
  skipTransition: () => void;
}
type StartViewTransition = (update: () => void) => ViewTransition;

/**
 * Apply a route change, animated when it should be: `apply` must render the new route (it runs inside
 * flushSync, so the new screen is in the DOM when the browser takes its second picture).
 */
export function transition(from: Route, to: Route, arrival: Arrival, apply: () => void): void {
  const start =
    typeof document !== "undefined"
      ? ((document as unknown as { startViewTransition?: StartViewTransition }).startViewTransition?.bind(document) ?? null)
      : null;
  let motion: NavMotion | null = motionFor(from, to, arrival);
  const wasZoom = zoomNext;
  zoomNext = false;
  if (motion === "push" && wasZoom && to.kind === "conversation") {
    motion = "zoom";
    zoomed = formatRoute({ ...to, prefill: null });
  } else if (motion === "pop" || motion === "zoom") {
    if (zoomed === formatRoute(from)) zoomed = null;
  }
  const drag = dragged;
  dragged = null;
  const ours = ownPop || !!drag;
  ownPop = false;
  if (arrival === "pop" && !ours) motion = null; // the browser's Back, already animated by the browser
  if (drag && motion === "zoom") motion = "pop";
  const update = () => {
    drag?.reset();
    flushSync(apply);
  };
  if (!start || !motion || (lastInput() === "key" && !drag)) return update();
  if (prefersReducedMotion()) motion = "fade";

  const root = document.documentElement;
  const mine = ++seq;
  root.dataset.nav = motion;
  if (motion === "pop" && drag) {
    const width = window.innerWidth || 390;
    const s = spring("smooth", drag.velocity / Math.max(1, width - drag.dx));
    root.style.setProperty("--nav-from", `${drag.dx}px`);
    root.style.setProperty("--nav-ease", s.easing);
    root.style.setProperty("--nav-ms", `${s.ms}ms`);
  }
  const t = start(update);
  const skip = () => t.skipTransition();
  window.addEventListener("pointerdown", skip, true);
  const done = () => {
    window.removeEventListener("pointerdown", skip, true);
    if (mine !== seq) return;
    delete root.dataset.nav;
    root.style.removeProperty("--nav-from");
    root.style.removeProperty("--nav-ease");
    root.style.removeProperty("--nav-ms");
  };
  t.finished.then(done, done);
}
