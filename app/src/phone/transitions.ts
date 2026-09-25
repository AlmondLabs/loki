import { flushSync } from "react-dom";
import { spring } from "../kit/spring";
import { prefersReducedMotion } from "../kit/motion";
import { formatRoute, type Arrival, type Route } from "./router";

/**
 * How the phone moves between screens, the way iOS does, drawn by the browser's View Transitions (the
 * old screen and the new one as two pictures, animated by phone.css under html[data-nav]):
 *   push   a page opened: it slides in from the right over the screen it came from, which drifts left and dims;
 *   pop    back: the page slides away to the right and the screen under it comes forward;
 *   zoom   the Inbox card opened grows into its conversation, and Back shrinks it into the card again.
 * Tab to tab does not move (as iOS's tab bar does not), nor does anything done from the keyboard: a key
 * pressed hundreds of times a day should not wait on an animation. Reduced motion is a short cross-fade.
 * Without View Transitions (older Safari), screens change at once, as they did before.
 *
 * A tap during a transition finishes it at once, so a slide never stands between a finger and the next page.
 */

export type NavMotion = "push" | "pop" | "zoom" | "fade";

/** The last thing that moved the app: a key, or a pointer (touch, mouse, pen). */
let lastInput: "key" | "pointer" = "pointer";
if (typeof window !== "undefined") {
  window.addEventListener("keydown", () => (lastInput = "key"), true);
  window.addEventListener("pointerdown", () => (lastInput = "pointer"), true);
}

/** The conversation opened from the Inbox card, whose Back shrinks into the card again. */
let zoomed: string | null = null;
let zoomNext = false;
/** Call just before opening the Inbox card's conversation: that push grows out of the card. */
export function openFromCard(): void {
  zoomNext = true;
}

/**
 * A Back that begins from a finger already partway across (the edge swipe, edgeSwipe.ts): the old picture
 * is taken as the page sits, dx across, and goes on from there at the finger's speed. `reset` puts the page
 * back in place before the new picture is taken.
 */
let dragged: { dx: number; velocity: number; reset: () => void } | null = null;
export function popFromDrag(dx: number, velocity: number, reset: () => void): void {
  dragged = { dx, velocity, reset };
}

const isPage = (r: Route) => r.kind !== "tab";

/** What a route change looks like on screen, or null for none. Pure but for the zoom memory (test/phone-transitions.test.ts). */
export function motionFor(from: Route, to: Route, arrival: Arrival, zoomedHash: string | null = zoomed): Exclude<NavMotion, "fade"> | null {
  if (arrival === "load" || formatRoute(from) === formatRoute(to)) return null;
  if (!isPage(from) && !isPage(to)) return null;
  if (arrival === "pop") {
    if (!isPage(from)) return null;
    if (zoomedHash === formatRoute(from) && to.kind === "tab" && to.tab === "inbox") return "zoom";
    return "pop";
  }
  if (arrival === "push") return isPage(to) ? "push" : null;
  // A replace that goes back (a cold page's Back to its parent) arrives as "pop" above; other swaps stay still.
  return null;
}

/** The newest transition; an older one finishing late must not clear what the newer one set. */
let seq = 0;

type ViewTransition = { finished: Promise<void>; skipTransition: () => void };
type StartViewTransition = (update: () => void) => ViewTransition;

/**
 * Apply a route change, animated when it should be: `apply` must render the new route (it runs inside
 * flushSync, so the new screen is in the DOM when the browser takes its second picture).
 */
export function transition(from: Route, to: Route, arrival: Arrival, apply: () => void): void {
  const start = typeof document !== "undefined" ? ((document as unknown as { startViewTransition?: StartViewTransition }).startViewTransition?.bind(document) ?? null) : null;
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
  // A finger already sliding the page away: carry on sliding it, even out of a card's conversation.
  if (drag && motion === "zoom") motion = "pop";
  const update = () => {
    drag?.reset();
    flushSync(apply);
  };
  if (!start || !motion || (lastInput === "key" && !drag)) return update();
  if (prefersReducedMotion()) motion = "fade";

  const root = document.documentElement;
  const mine = ++seq;
  root.dataset.nav = motion;
  if (motion === "pop" && drag) {
    // The page is already this far across: start there, keep the finger's speed.
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
    if (mine !== seq) return; // a newer transition has taken over
    delete root.dataset.nav;
    root.style.removeProperty("--nav-from");
    root.style.removeProperty("--nav-ease");
    root.style.removeProperty("--nav-ms");
  };
  t.finished.then(done, done);
}
