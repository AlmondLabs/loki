/**
 * Motion that CSS cannot see. The stylesheet zeroes every CSS duration and delay under
 * `prefers-reduced-motion: reduce` (kit/tokens.css); JS-driven moves — the camera glides through
 * react-zoom-pan-pinch — ask here instead.
 */
const query = typeof window !== "undefined" && typeof window.matchMedia === "function" ? window.matchMedia("(prefers-reduced-motion: reduce)") : null;

/** True while the person has asked the OS for less motion. Read at call time; the setting can change mid-session. */
export function prefersReducedMotion(): boolean {
  return !!query?.matches;
}

/** A glide's duration, or 0 (an instant jump) under reduced motion. */
export function glide(ms: number): number {
  return prefersReducedMotion() ? 0 : ms;
}

/**
 * The last way the person drove the page: a key or a pointer. What a key starts never animates (a desk
 * switched by shortcut, Enter in a list); the same thing by click or touch may.
 */
let input: "key" | "pointer" = "pointer";
if (typeof window !== "undefined") {
  window.addEventListener("keydown", () => (input = "key"), true);
  window.addEventListener("pointerdown", () => (input = "pointer"), true);
}
export function lastInput(): "key" | "pointer" {
  return input;
}
